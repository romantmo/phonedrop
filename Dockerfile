# Dockerfile — рецепт «коробки» с приложением.
# Docker читает его сверху вниз и собирает образ: готовую систему с Python,
# библиотеками и нашим кодом. Этот образ одинаково запускается где угодно.

# 1. Берём готовую основу: маленький Linux с Python 3.13.
FROM python:3.13-slim

# 2. Настройки Python: не создавать лишних файлов, сразу писать логи.
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

WORKDIR /srv

# 3. LibreOffice (без графического интерфейса) — превращает Word/Excel/PowerPoint в PDF.
#    Шрифты: DejaVu и Liberation (кириллица, иврит, замена Arial/Times), Carlito и Caladea
#    (замена Calibri и Cambria — чтобы документы из Word не «разъезжались»).
#    Этот шаг тяжёлый, но Docker его запоминает и повторяет, только если список изменится.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        libreoffice-writer-nogui libreoffice-calc-nogui libreoffice-impress-nogui \
        fonts-dejavu-core fonts-liberation fonts-crosextra-carlito fonts-crosextra-caladea \
    && rm -rf /var/lib/apt/lists/*

# 4. Сначала только список библиотек — так Docker запомнит этот шаг
#    и не будет переустанавливать библиотеки, если поменялся только код.
COPY requirements.txt .
RUN pip install -r requirements.txt

# 5. Теперь сам код: приложение и конвертер.
#    Из одного образа запускаются два контейнера (см. deploy/compose.yaml).
COPY app ./app
COPY converter ./converter

# 6. Безопасность: запускаем не от root, а от обычного пользователя.
#    Даже если в приложении найдут дыру, взломщик не получит права администратора.
RUN useradd --system --uid 10001 --no-create-home appuser \
    && mkdir -p /data \
    && chown appuser /data
USER appuser

# 7. Где хранить базу и файлы. На сервере сюда подключается том (volume),
#    чтобы данные не пропадали при обновлении «коробки».
ENV DATA_DIR=/data

# 8. Номер версии — его подставит CI при сборке. Виден на /healthz.
ARG APP_VERSION=dev
ENV APP_VERSION=${APP_VERSION}

EXPOSE 8000

# 9. Docker сам раз в 30 секунд проверяет, живо ли приложение.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/healthz', timeout=3)"

# 10. Команда запуска. --proxy-headers: приложение будет стоять за Caddy (HTTPS)
#    и должно видеть настоящий IP посетителя и то, что соединение защищённое.
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", \
     "--proxy-headers", "--forwarded-allow-ips", "*"]
