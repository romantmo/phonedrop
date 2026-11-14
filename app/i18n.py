"""Переводы того, что пишет сервер: ошибки, push-уведомления, имена файлов.

Как это устроено (для чайника):
- В коде все тексты остаются по-русски — так их легче читать.
- Текст с подстановками пишем как T("Лимит {n} МБ", n=10): по-русски это обычная строка,
  но T помнит шаблон, и его можно перевести целиком.
- Перед ответом сервер смотрит язык человека (cookie pd_lang, её ставит страница) и меняет
  русский текст на перевод из словаря EN / HE ниже. Нет перевода — остаётся русский.
"""
from __future__ import annotations

LANGS = ("ru", "en", "he")
LANG_COOKIE = "pd_lang"


class T(str):
    """Строка для человека: выглядит как готовый русский текст, но помнит шаблон и подстановки."""

    tpl: str
    kw: dict

    def __new__(cls, tpl: str, **kw):
        obj = super().__new__(cls, tpl.format(**kw) if kw else tpl)
        obj.tpl, obj.kw = tpl, kw
        return obj


def tr(text, lang: str):
    """Перевести строку (или T-шаблон) на язык lang. Всё, чего нет в словаре, остаётся как есть."""
    if not isinstance(text, str) or lang not in DICTS:
        return text
    words = DICTS[lang]
    if isinstance(text, T):
        tpl = words.get(text.tpl)
        if not tpl:
            return str(text)
        # подстановки тоже могут быть фразами (ошибка внутри ошибки) — переводим и их
        kw = {k: tr(v, lang) if isinstance(v, T) else words.get(v, v) if isinstance(v, str) else v
              for k, v in text.kw.items()}
        return tpl.format(**kw)
    return words.get(text, text)


def pick_lang(cookie: str | None, accept_language: str | None) -> str:
    """Язык человека: сначала выбор в приложении (cookie), потом язык браузера. Без подсказок — русский."""
    if cookie in LANGS:
        return cookie
    if not accept_language:
        return "ru"
    for part in accept_language.split(","):
        code = part.split(";")[0].strip().lower()[:2]
        if code in ("ru", "uk", "be", "kk"):
            return "ru"
        if code in ("he", "iw"):
            return "he"
        if code == "en":
            return "en"
    return "en"


# Ключ — русский текст из app/main.py. Тест следит, чтобы ни одна фраза не осталась без перевода.
EN: dict[str, str] = {
    "Звонок уже закончился": "The call has already ended",
    "Собеседник ещё не вошёл в чат — сначала отправь ему код": "The other person hasn't joined the chat yet — send them the code first",
    "В этом чате уже идёт звонок": "There's already a call in this chat",
    "На звонок уже ответили на другом устройстве": "The call was already answered on another device",
    "📞 Пропущенный звонок": "📞 Missed call",
    "🎥 Входящий видеозвонок": "🎥 Incoming video call",
    "📞 Входящий звонок": "📞 Incoming call",
    "Чат не найден": "Chat not found",
    "Google вернул неверные данные — попробуй ещё раз": "Google returned invalid data — please try again",
    "Google не ответил — попробуй ещё раз": "Google didn't respond — please try again",
    "{first} (объединённый).pdf": "{first} (merged).pdf",
    "{first} (сжатый).pdf": "{first} (compressed).pdf",
    "{first} и ещё {more}": "{first} and {more} more",
    "{first} — стр. {n}.jpg": "{first} — page {n}.jpg",
    "{name} · {n} МБ — скачай в течение {transfer_ttl_hours} ч": "{name} · {n} MB — download within {transfer_ttl_hours} h",
    "«{name}» — не фото": "“{name}” is not a photo",
    "Администратора можно убрать только в файле .env на сервере": "An admin can only be removed in the .env file on the server",
    "В этом чате закончилось место ({chat_quota_mb} МБ). Удали старые файлы": "This chat is out of space ({chat_quota_mb} MB). Delete old files",
    "Вместе получится больше {MAX_DEVICES} компьютеров. Отключи ненужные": "Together that's more than {MAX_DEVICES} computers. Disconnect the ones you don't need",
    "Вход отменён": "Sign-in cancelled",
    "Вход устарел — попробуй ещё раз": "Sign-in expired — please try again",
    "Вход через Google не настроен": "Google sign-in is not set up",
    "Выбери один PDF": "Choose one PDF",
    "Выбери один документ Word, Excel или PowerPoint": "Choose one Word, Excel or PowerPoint document",
    "Выбери файлы": "Choose files",
    "Выбери хотя бы два PDF": "Choose at least two PDFs",
    "Голосовое сообщение должно быть аудиофайлом": "A voice message must be an audio file",
    "Добавь от 1 до 20 фото за раз": "Add 1 to 20 photos at a time",
    "Добавь хотя бы одну страницу": "Add at least one page",
    "Догружать файл может только отправитель": "Only the sender can continue uploading this file",
    "Доступ закрыт: адреса {email} нет в списке разрешённых. Попроси владельца добавить его": "Access denied: {email} is not on the allowed list. Ask the owner to add it",
    "Запрос с чужого сайта отклонён": "Request from another site was rejected",
    "Здесь можно использовать только фото и картинки": "Only photos and images can be used here",
    "Код не подходит: проверь цифры. Код одноразовый и действует сутки": "Code doesn't match: check the digits. The code works once and is valid for 24 hours",
    "Код недействителен или уже использован. Обнови страницу на компьютере": "Code is invalid or already used. Refresh the page on the computer",
    "Код недействителен. Обнови страницу на компьютере и отсканируй новый QR": "Code is invalid. Refresh the page on the computer and scan the new QR",
    "Код уже использован": "Code already used",
    "Компьютер": "Computer",
    "Компьютер уже подключён": "Computer is already connected",
    "Компьютер-получатель не найден": "Recipient computer not found",
    "Конвертер вернул повреждённый ответ": "The converter returned a broken response",
    "Конвертер не справился с этим файлом": "The converter couldn't handle this file",
    "Конвертер сейчас недоступен, попробуй через минуту": "The converter is unavailable right now, try again in a minute",
    "Лимит — {n} ГБ файлов одновременно. Удали старые передачи или подожди, пока они удалятся сами": "Limit is {n} GB of files at a time. Delete old transfers or wait until they expire",
    "Можно переписываться": "You can chat now",
    "На сервере заканчивается место, попробуй позже": "The server is running out of space, try later",
    "На сервере сейчас не хватает места для такого файла. Попробуй позже": "Not enough space on the server for this file right now. Try later",
    "Название не может быть пустым": "Name can't be empty",
    "Не больше 50 страниц в одном PDF": "No more than 50 pages in one PDF",
    "Не больше {MAX_ROOMS} чатов. Закрой старые": "No more than {MAX_ROOMS} chats. Close old ones",
    "Не больше {MAX_USERS} пользователей": "No more than {MAX_USERS} users",
    "Не получилось конвертировать файл": "Couldn't convert the file",
    "Не получилось показать документ: {detail}": "Couldn't show the document: {detail}",
    "Не то место в файле": "Wrong position in the file",
    "Неверная подписка": "Invalid subscription",
    "Неверный заголовок Content-Length": "Invalid Content-Length header",
    "Неверный запрос": "Bad request",
    "Неизвестная роль": "Unknown role",
    "Неизвестное место": "Unknown place",
    "Неизвестный инструмент": "Unknown tool",
    "Неизвестный режим": "Unknown mode",
    "Нет заголовка X-PD-Role": "Missing X-PD-Role header",
    "Нет подключения. Отсканируй QR-код на компьютере": "Not connected. Scan the QR code on the computer",
    "Нечего отправлять": "Nothing to send",
    "Обнови страницу и попробуй ещё раз": "Refresh the page and try again",
    "Передача не найдена — возможно, прошли сутки и файл удалён": "Transfer not found — maybe 24 hours passed and the file was deleted",
    "Переподключать телефон можно только через «Мой компьютер»": "You can reconnect the phone only from “My computer”",
    "Подключено максимум компьютеров ({MAX_DEVICES}). Отключи ненужные": "Maximum number of computers connected ({MAX_DEVICES}). Disconnect the ones you don't need",
    "Приглашение не работает: его уже использовали или прошли сутки. Попроси новый код": "The invite doesn't work: it was already used or 24 hours passed. Ask for a new code",
    "Пустое сообщение": "Empty message",
    "Пустой файл отправлять незачем": "No point sending an empty file",
    "Сервер перегружен, попробуй через пару минут": "The server is busy, try again in a couple of minutes",
    "Скан": "Scan",
    "Слишком большая часть файла": "File chunk is too large",
    "Слишком большое фото. Лимит {tool_max_mb} МБ": "Photo is too large. Limit is {tool_max_mb} MB",
    "Слишком большой размер. Лимит {limit_mb} МБ за раз": "Too large. Limit is {limit_mb} MB at a time",
    "Слишком большой размер. Лимит {tool_max_mb} МБ за раз": "Too large. Limit is {tool_max_mb} MB at a time",
    "Слишком большой файл. Максимум {n} ГБ": "File is too large. Maximum is {n} GB",
    "Слишком длинное голосовое": "Voice message is too long",
    "Слишком длинные параметры": "Parameters are too long",
    "Слишком длинный текст (максимум {MAX_TEXT_CHARS} символов)": "Text is too long (maximum {MAX_TEXT_CHARS} characters)",
    "Слишком много запросов. Подожди немного и попробуй снова": "Too many requests. Wait a little and try again",
    "Слишком много незаконченных загрузок — дождись их или удали": "Too many unfinished uploads — wait for them or delete them",
    "Слишком много файлов в результате": "Too many files in the result",
    "Сначала войди через Google — кнопка на главном экране приложения": "Sign in with Google first — the button is on the app's main screen",
    "Сначала привяжи Google — иначе после выхода не сможешь вернуться к своим чатам": "Link Google first — otherwise after signing out you won't get back to your chats",
    "Собеседник": "Contact",
    "Создатель чата может его только закрыть": "The chat creator can only close it",
    "Сообщение не найдено": "Message not found",
    "Страница не найдена": "Page not found",
    "Страница не найдена — фото хранятся {tool_ttl_min} минут": "Page not found — photos are kept for {tool_ttl_min} minutes",
    "Такого адреса нет в списке": "This address is not on the list",
    "Твои чаты открыты на другом телефоне. Если это был не ты — войди снова и смени пароль Google.": "Your chats were opened on another phone. If it wasn't you, sign in again and change your Google password.",
    "Удалять можно только свои сообщения": "You can delete only your own messages",
    "Файл больше {tool_max_mb} МБ — его можно только скачать": "The file is larger than {tool_max_mb} MB — it can only be downloaded",
    "Файл ещё загружается": "The file is still uploading",
    "Файл не найден": "File not found",
    "Файл не найден — возможно, прошли сутки и загрузка удалена": "File not found — maybe 24 hours passed and the upload was deleted",
    "Файл не найден — возможно, прошли сутки и он удалён": "File not found — maybe 24 hours passed and it was deleted",
    "Файл не найден — результаты хранятся {tool_ttl_min} минут": "File not found — results are kept for {tool_ttl_min} minutes",
    "Файл удалён: он хранился {file_ttl_days} дней": "File deleted: it was kept for {file_ttl_days} days",
    "Файл удалён: файлы в чате хранятся {transfer_ttl_hours} ч": "File deleted: files in a chat are kept for {transfer_ttl_hours} h",
    "Файл уже удалён": "The file has already been deleted",
    "Чат не найден — возможно, его закрыли": "Chat not found — maybe it was closed",
    "Чат не найден — возможно, компьютер отключили": "Chat not found — maybe the computer was disconnected",
    "Чтобы продолжить, отправь ему новый код": "To continue, send them a new code",
    "Это действие недоступно": "This action isn't available",
    "Это может только администратор": "Only an admin can do this",
    "Это может только тот, кто создал чат": "Only the person who created the chat can do this",
    "Это не похоже на адрес почты. Пример: mama@gmail.com": "That doesn't look like an email address. Example: mom@gmail.com",
    "Это приглашение в твой же чат. Отправь код собеседнику — войти должен он": "This is an invite to your own chat. Send the code to the other person — they should join",
    "Этот адрес уже в списке": "This address is already on the list",
    "Этот компьютер уже подключён к другому аккаунту — сначала отключи его": "This computer is already linked to another account — disconnect it first",
    "Этот файл нельзя конвертировать": "This file can't be converted",
    "Этот файл нельзя показать как PDF": "This file can't be shown as PDF",
    "✅ {title} вошёл в чат": "✅ {title} joined the chat",
    "🎤 Голосовое сообщение": "🎤 Voice message",
    "📦 Файл с «{from_label}»": "📦 File from “{from_label}”",
    "📱 Телефон": "📱 Phone",
    "🚪 {title} вышел из чата": "🚪 {title} left the chat",
}

HE: dict[str, str] = {
    "Звонок уже закончился": "השיחה כבר הסתיימה",
    "Собеседник ещё не вошёл в чат — сначала отправь ему код": "הצד השני עוד לא נכנס לצ'אט — שלחו לו קודם את הקוד",
    "В этом чате уже идёт звонок": "כבר מתקיימת שיחה בצ'אט הזה",
    "На звонок уже ответили на другом устройстве": "כבר ענו לשיחה במכשיר אחר",
    "📞 Пропущенный звонок": "📞 שיחה שלא נענתה",
    "🎥 Входящий видеозвонок": "🎥 שיחת וידאו נכנסת",
    "📞 Входящий звонок": "📞 שיחה נכנסת",
    "Чат не найден": "הצ'אט לא נמצא",
    "Google вернул неверные данные — попробуй ещё раз": "Google החזיר נתונים שגויים — נסו שוב",
    "Google не ответил — попробуй ещё раз": "Google לא הגיב — נסו שוב",
    "{first} (объединённый).pdf": "{first} (מאוחד).pdf",
    "{first} (сжатый).pdf": "{first} (דחוס).pdf",
    "{first} и ещё {more}": "{first} ועוד {more}",
    "{first} — стр. {n}.jpg": "{first} — עמוד {n}.jpg",
    "{name} · {n} МБ — скачай в течение {transfer_ttl_hours} ч": "{name} · {n} MB — יש להוריד תוך {transfer_ttl_hours} שעות",
    "«{name}» — не фото": "„{name}” אינו תמונה",
    "Администратора можно убрать только в файле .env на сервере": "אפשר להסיר מנהל רק בקובץ ‎.env בשרת",
    "В этом чате закончилось место ({chat_quota_mb} МБ). Удали старые файлы": "נגמר המקום בצ'אט הזה ({chat_quota_mb} MB). מחקו קבצים ישנים",
    "Вместе получится больше {MAX_DEVICES} компьютеров. Отключи ненужные": "ביחד יהיו יותר מ-{MAX_DEVICES} מחשבים. נתקו את המיותרים",
    "Вход отменён": "הכניסה בוטלה",
    "Вход устарел — попробуй ещё раз": "תוקף הכניסה פג — נסו שוב",
    "Вход через Google не настроен": "כניסה עם Google לא הוגדרה",
    "Выбери один PDF": "בחרו קובץ PDF אחד",
    "Выбери один документ Word, Excel или PowerPoint": "בחרו מסמך Word,‏ Excel או PowerPoint אחד",
    "Выбери файлы": "בחרו קבצים",
    "Выбери хотя бы два PDF": "בחרו לפחות שני קובצי PDF",
    "Голосовое сообщение должно быть аудиофайлом": "הודעה קולית חייבת להיות קובץ שמע",
    "Добавь от 1 до 20 фото за раз": "הוסיפו בין 1 ל-20 תמונות בכל פעם",
    "Добавь хотя бы одну страницу": "הוסיפו לפחות עמוד אחד",
    "Догружать файл может только отправитель": "רק השולח יכול להמשיך להעלות את הקובץ",
    "Доступ закрыт: адреса {email} нет в списке разрешённых. Попроси владельца добавить его": "הגישה חסומה: הכתובת {email} לא ברשימת המורשים. בקשו מהבעלים להוסיף אותה",
    "Запрос с чужого сайта отклонён": "בקשה מאתר אחר נדחתה",
    "Здесь можно использовать только фото и картинки": "כאן אפשר להשתמש רק בתמונות",
    "Код не подходит: проверь цифры. Код одноразовый и действует сутки": "הקוד לא מתאים: בדקו את הספרות. הקוד חד-פעמי ותקף 24 שעות",
    "Код недействителен или уже использован. Обнови страницу на компьютере": "הקוד לא תקף או שכבר נוצל. רעננו את הדף במחשב",
    "Код недействителен. Обнови страницу на компьютере и отсканируй новый QR": "הקוד לא תקף. רעננו את הדף במחשב וסרקו QR חדש",
    "Код уже использован": "הקוד כבר נוצל",
    "Компьютер": "מחשב",
    "Компьютер уже подключён": "המחשב כבר מחובר",
    "Компьютер-получатель не найден": "מחשב היעד לא נמצא",
    "Конвертер вернул повреждённый ответ": "הממיר החזיר תשובה פגומה",
    "Конвертер не справился с этим файлом": "הממיר לא הצליח לטפל בקובץ הזה",
    "Конвертер сейчас недоступен, попробуй через минуту": "הממיר לא זמין כרגע, נסו שוב בעוד דקה",
    "Лимит — {n} ГБ файлов одновременно. Удали старые передачи или подожди, пока они удалятся сами": "המגבלה היא {n} GB של קבצים בו-זמנית. מחקו העברות ישנות או חכו שיימחקו מעצמן",
    "Можно переписываться": "אפשר להתכתב",
    "На сервере заканчивается место, попробуй позже": "נגמר המקום בשרת, נסו מאוחר יותר",
    "На сервере сейчас не хватает места для такого файла. Попробуй позже": "אין כרגע מספיק מקום בשרת לקובץ כזה. נסו מאוחר יותר",
    "Название не может быть пустым": "השם לא יכול להיות ריק",
    "Не больше 50 страниц в одном PDF": "לא יותר מ-50 עמודים ב-PDF אחד",
    "Не больше {MAX_ROOMS} чатов. Закрой старые": "לא יותר מ-{MAX_ROOMS} צ'אטים. סגרו ישנים",
    "Не больше {MAX_USERS} пользователей": "לא יותר מ-{MAX_USERS} משתמשים",
    "Не получилось конвертировать файл": "לא הצלחנו להמיר את הקובץ",
    "Не получилось показать документ: {detail}": "לא הצלחנו להציג את המסמך: {detail}",
    "Не то место в файле": "מיקום שגוי בקובץ",
    "Неверная подписка": "מינוי לא תקין",
    "Неверный заголовок Content-Length": "כותרת Content-Length לא תקינה",
    "Неверный запрос": "בקשה לא תקינה",
    "Неизвестная роль": "תפקיד לא ידוע",
    "Неизвестное место": "מקום לא ידוע",
    "Неизвестный инструмент": "כלי לא ידוע",
    "Неизвестный режим": "מצב לא ידוע",
    "Нет заголовка X-PD-Role": "חסרה כותרת X-PD-Role",
    "Нет подключения. Отсканируй QR-код на компьютере": "אין חיבור. סרקו את קוד ה-QR במחשב",
    "Нечего отправлять": "אין מה לשלוח",
    "Обнови страницу и попробуй ещё раз": "רעננו את הדף ונסו שוב",
    "Передача не найдена — возможно, прошли сутки и файл удалён": "ההעברה לא נמצאה — אולי עברו 24 שעות והקובץ נמחק",
    "Переподключать телефон можно только через «Мой компьютер»": "אפשר לחבר מחדש את הטלפון רק דרך „המחשב שלי”",
    "Подключено максимум компьютеров ({MAX_DEVICES}). Отключи ненужные": "מחובר המספר המרבי של מחשבים ({MAX_DEVICES}). נתקו את המיותרים",
    "Приглашение не работает: его уже использовали или прошли сутки. Попроси новый код": "ההזמנה לא עובדת: כבר נוצלה או שעברו 24 שעות. בקשו קוד חדש",
    "Пустое сообщение": "הודעה ריקה",
    "Пустой файл отправлять незачем": "אין טעם לשלוח קובץ ריק",
    "Сервер перегружен, попробуй через пару минут": "השרת עמוס, נסו שוב בעוד כמה דקות",
    "Скан": "סריקה",
    "Слишком большая часть файла": "חלק הקובץ גדול מדי",
    "Слишком большое фото. Лимит {tool_max_mb} МБ": "התמונה גדולה מדי. המגבלה היא {tool_max_mb} MB",
    "Слишком большой размер. Лимит {limit_mb} МБ за раз": "גדול מדי. המגבלה היא {limit_mb} MB בכל פעם",
    "Слишком большой размер. Лимит {tool_max_mb} МБ за раз": "גדול מדי. המגבלה היא {tool_max_mb} MB בכל פעם",
    "Слишком большой файл. Максимум {n} ГБ": "הקובץ גדול מדי. המקסימום הוא {n} GB",
    "Слишком длинное голосовое": "ההודעה הקולית ארוכה מדי",
    "Слишком длинные параметры": "הפרמטרים ארוכים מדי",
    "Слишком длинный текст (максимум {MAX_TEXT_CHARS} символов)": "הטקסט ארוך מדי (עד {MAX_TEXT_CHARS} תווים)",
    "Слишком много запросов. Подожди немного и попробуй снова": "יותר מדי בקשות. חכו קצת ונסו שוב",
    "Слишком много незаконченных загрузок — дождись их или удали": "יותר מדי העלאות שלא הסתיימו — חכו להן או מחקו אותן",
    "Слишком много файлов в результате": "יותר מדי קבצים בתוצאה",
    "Сначала войди через Google — кнопка на главном экране приложения": "קודם היכנסו עם Google — הכפתור במסך הראשי של האפליקציה",
    "Сначала привяжи Google — иначе после выхода не сможешь вернуться к своим чатам": "קודם קשרו חשבון Google — אחרת אחרי היציאה לא תוכלו לחזור לצ'אטים שלכם",
    "Собеседник": "איש קשר",
    "Создатель чата может его только закрыть": "יוצר הצ'אט יכול רק לסגור אותו",
    "Сообщение не найдено": "ההודעה לא נמצאה",
    "Страница не найдена": "העמוד לא נמצא",
    "Страница не найдена — фото хранятся {tool_ttl_min} минут": "העמוד לא נמצא — התמונות נשמרות {tool_ttl_min} דקות",
    "Такого адреса нет в списке": "הכתובת הזאת לא ברשימה",
    "Твои чаты открыты на другом телефоне. Если это был не ты — войди снова и смени пароль Google.": "הצ'אטים שלכם נפתחו בטלפון אחר. אם זה לא הייתם אתם — היכנסו שוב והחליפו את סיסמת Google.",
    "Удалять можно только свои сообщения": "אפשר למחוק רק הודעות שלכם",
    "Файл больше {tool_max_mb} МБ — его можно только скачать": "הקובץ גדול מ-{tool_max_mb} MB — אפשר רק להוריד אותו",
    "Файл ещё загружается": "הקובץ עדיין עולה",
    "Файл не найден": "הקובץ לא נמצא",
    "Файл не найден — возможно, прошли сутки и загрузка удалена": "הקובץ לא נמצא — אולי עברו 24 שעות וההעלאה נמחקה",
    "Файл не найден — возможно, прошли сутки и он удалён": "הקובץ לא נמצא — אולי עברו 24 שעות והוא נמחק",
    "Файл не найден — результаты хранятся {tool_ttl_min} минут": "הקובץ לא נמצא — התוצאות נשמרות {tool_ttl_min} דקות",
    "Файл удалён: он хранился {file_ttl_days} дней": "הקובץ נמחק: הוא נשמר {file_ttl_days} ימים",
    "Файл удалён: файлы в чате хранятся {transfer_ttl_hours} ч": "הקובץ נמחק: קבצים בצ'אט נשמרים {transfer_ttl_hours} שעות",
    "Файл уже удалён": "הקובץ כבר נמחק",
    "Чат не найден — возможно, его закрыли": "הצ'אט לא נמצא — אולי הוא נסגר",
    "Чат не найден — возможно, компьютер отключили": "הצ'אט לא נמצא — אולי המחשב נותק",
    "Чтобы продолжить, отправь ему новый код": "כדי להמשיך, שלחו לו קוד חדש",
    "Это действие недоступно": "הפעולה הזאת לא זמינה",
    "Это может только администратор": "רק מנהל יכול לעשות את זה",
    "Это может только тот, кто создал чат": "רק מי שיצר את הצ'אט יכול לעשות את זה",
    "Это не похоже на адрес почты. Пример: mama@gmail.com": "זה לא נראה כמו כתובת מייל. לדוגמה: mom@gmail.com",
    "Это приглашение в твой же чат. Отправь код собеседнику — войти должен он": "זאת הזמנה לצ'אט שלכם. שלחו את הקוד לצד השני — הוא זה שצריך להיכנס",
    "Этот адрес уже в списке": "הכתובת הזאת כבר ברשימה",
    "Этот компьютер уже подключён к другому аккаунту — сначала отключи его": "המחשב הזה כבר מחובר לחשבון אחר — נתקו אותו קודם",
    "Этот файл нельзя конвертировать": "אי אפשר להמיר את הקובץ הזה",
    "Этот файл нельзя показать как PDF": "אי אפשר להציג את הקובץ הזה כ-PDF",
    "✅ {title} вошёл в чат": "✅ {title} הצטרף לצ'אט",
    "🎤 Голосовое сообщение": "🎤 הודעה קולית",
    "📦 Файл с «{from_label}»": "📦 קובץ מ„{from_label}”",
    "📱 Телефон": "📱 טלפון",
    "🚪 {title} вышел из чата": "🚪 {title} יצא מהצ'אט",
}
DICTS = {"en": EN, "he": HE}
