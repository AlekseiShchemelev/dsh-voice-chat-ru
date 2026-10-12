# 4. Установка

```bash
# Этот форк (установка по git-адресу):
dsh plugin --profile web add https://github.com/AlekseiShchemelev/dsh-voice-chat-ru.git

# Оригинальная версия (опубликована в npm):
dsh plugin --profile web add dsh-voice-chat

# Перезапустите dsh web для активации плагина
```

После успешной установки:
- Плагин автоматически регистрируется на уровне profile (в `bundles` файла `~/.dsh/profiles/web/package.json` появляется `dsh-voice-chat`);
- После обновления страницы в браузере справа от поля ввода появляются кнопки 🎤 и 🔊.
