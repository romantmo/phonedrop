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

# 3. Сначала только список библиотек — так Docker запомнит этот шаг
#    и не будет переустанавливать библиотеки, если поменялся только код.
COPY requirements.txt .
RUN pip install -r requirements.txt

# 4. Теперь сам код приложения.
COPY app ./app

# 5. Безопасность: запускаем не от root, а от обычного пользователя.
#    Даже если в приложении найдут дыру, взломщик не получит права администратора.
RUN useradd --system --uid 10001 --no-create-home appuser \
    && mkdir -p /data \
    && chown appuser /data
USER appuser

# 6. Где хранить базу и файлы. На сервере сюда подключается том (volume),
#    чтобы данные не пропадали при обновлении «коробки».
ENV DATA_DIR=/data

# 7. Номер версии — его подставит CI при сборке. Виден на /healthz.
ARG APP_VERSION=dev
ENV APP_VERSION=${APP_VERSION}

EXPOSE 8000

# 8. Docker сам раз в 30 секунд проверяет, живо ли приложение.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/healthz', timeout=3)"

# 9. Команда запуска. --proxy-headers: приложение будет стоять за Caddy (HTTPS)
#    и должно видеть настоящий IP посетителя и то, что соединение защищённое.
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", \
     "--proxy-headers", "--forwarded-allow-ips", "*"]
