"""Общие фикстуры: тесты в других файлах могут просить client, pc, phone."""
import os

# Тестовые push-адреса (push.example) — в списке разрешённых только для тестов.
os.environ.setdefault("PUSH_HOSTS", "push.example,fcm.googleapis.com")

from test_app import client, pc, phone, settings  # noqa: E402,F401
from test_sysadmin import admin, clamd, net_client, net_settings, site  # noqa: E402,F401
