# Changelog

Формат: [Keep a Changelog](https://keepachangelog.com/ru/1.1.0/), версии по [SemVer](https://semver.org/lang/ru/).

## Unreleased

- The window no longer resizes at all (a constant transparent, click-through stage): no more stale "second pet" frame when a panel opens. Settings have a fixed height so switching tabs does not jump.
- Usage ring number is centered.
- The usage ring lives in the status chip: a small arc next to the status dot that settles at the end of the row when the chip unfolds.
- The window has a constant width and the UI hangs from its bottom edge, so opening or closing panels never moves or shakes the pet.
- Panels (settings, chat, sessions, limits, notices) slide out of the pet and fold back with GSAP; they open upwards so the pet never moves.
- The status chip rests as a colored dot (green ready, blue thinking, cyan reading, violet writing, orange running, yellow testing, red permission/error, pink subagent, lime done, grey asleep); the word and details unfold on hover. A legend is in Settings.
- Settings: the RGB editor (sliders + HEX) stays open until closed instead of resetting after one click.
- Chinese (中文) interface language; compact settings split into five tabs.
- Hover and state animations are driven by GSAP (interruptible timelines: they turn around mid-way instead of jumping).
- The status chip rests as a dot and a word next to the pet and slides out on hover.
- The usage ring is a small, quiet arc by the pet that grows and shows its number on hover.
- Smoother hover animations (no window resizing during the slide-out, no spring overshoot).

## [0.2.0] — первый публичный релиз
### Добавлено
- Общая живая сессия Claude Code между терминалом и питомцем (PTY-обёртка `pet-claude.py`, unix-сокет, один процесс и один транскрипт); Stop и обнаружение Esc/Ctrl+C из терминала.
- Живые лимиты подписки (5 часов и неделя) через `get_usage` Agent SDK, обновление раз в минуту короткими процессами, без перекрывающихся запросов; состояния «свежие / устарели / недоступны».
- Модель по умолчанию **Clawd** (с удалением светлой каймы); прежняя Shy Miku больше не поставляется, её можно установить как свою модель.
- Кнопки (чат, настройки, сессии) скрыты: под питомцем лежит тень, а при наведении из неё вырастает плашка с кнопками. Размер питомца 60–180% (ползунок в настройках или меню трея).
- Интерфейс на русском и английском (по языку системы или вручную в настройках).
- Плавные анимации (кросс-фейд кадров, мягкий «поп» при смене состояния, «дыхание» в покое; отключается при «уменьшить движение»), счётчик лимита показывает 100 и замыкается.
- Разрешения для чата питомца: спрашивать / правки без вопросов / всё без вопросов (по умолчанию спрашивать); сессии в списке сворачиваются (3 ч покоя → сон, потолок 15).
- Настройки: цвет питомца и акцентный цвет с мгновенным предпросмотром и сохранением.
- Менеджер моделей: выбор и предпросмотр без перезапуска, установка из ZIP с проверкой (защита от выхода за пределы папки, ссылок, «бомб», скриптов), вкладка NPM (сторонний `codex-pets`), удаление с подтверждением.
- Управляемая настройка терминала: `install-shell-integration.sh` (diff, подтверждение, резервная копия, откат) и пункт трея «Подключить терминал (WSL)…».
- Документация: README, приватность, диагностика, уведомления о сторонних компонентах; лицензия MIT.

### Исправлено
- Запасной путь SDK продолжает сессию в исходной папке и не продолжает молча в копии (`resumeCwd`, проверка session ID).
- Диалоги подтверждения: Enter теперь выбирает безопасную кнопку.
- Запись ответа в чат после Stop; состояние после прерывания Esc.
