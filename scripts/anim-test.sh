#!/usr/bin/env bash
# Cycles the running pet through every state (10 s each) by feeding fake hook events to the bridge socket.
set -uo pipefail
export PATH="$HOME/.local/node/bin:$PATH"
HOOK="$(dirname "$0")/../hook/pet-hook.mjs"
SID="anim-test-$$"; CWD="/tmp/анимации-тест"; STEP="${STEP:-10}"
ev() { printf '{"hook_event_name":"%s","session_id":"%s","cwd":"%s"%s}' "$1" "$SID" "$CWD" "${2:-}" | node "$HOOK"; }
show() { printf '%s  %-22s %s\n' "$(date +%H:%M:%S)" "$1" "$2"; sleep "$STEP"; }
ev SessionStart;                                                        show "Готов"            "покой"
ev UserPromptSubmit;                                                    show "Думает"           "работа (руки у груди)"
ev PreToolUse ',"tool_name":"Read"';                                    show "Изучает"          "проверка (руки скрещены)"
ev PreToolUse ',"tool_name":"Edit"';                                    show "Пишет код"        "работа"
ev PreToolUse ',"tool_name":"Bash","tool_input":{"command":"ls -la"}';  show "Запускает команду" "работа"
ev PreToolUse ',"tool_name":"Bash","tool_input":{"command":"npm test"}'; show "Тестирует"       "проверка"
ev PreToolUse ',"tool_name":"Task"';                                    show "Субагент работает" "бег"
ev Notification ',"message":"Claude needs your permission to use Bash"'; show "Ждёт разрешения" "ожидание (терракота)"
ev PostToolUse ',"tool_response":{"is_error":true}';                    show "Ошибка"           "грусть (терракота)"
ev Stop;                                                                show "Готово"           "прыжок, потом машет"
ev UserPromptSubmit; ev SessionEnd;                                     show "Спит"             "покой"
echo "$(date +%H:%M:%S)  конец теста"
