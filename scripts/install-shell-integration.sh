#!/usr/bin/env bash
# Claude Pet: connects the terminal. Adds (or removes) one `claude` function to ~/.bashrc, so that a normal `claude`
# starts Claude Code through Claude Pet's PTY wrapper (the pet and the terminal then share ONE live session).
#
#   bash install-shell-integration.sh               show the change, ask, back up ~/.bashrc, apply
#   bash install-shell-integration.sh --yes         same without the question
#   bash install-shell-integration.sh --print       only print the block that would be added
#   bash install-shell-integration.sh --uninstall   remove the block again (also asks, also backs up)
#
# Only the block between the two marker lines is ever touched. Nothing else in the file is read or changed.
set -euo pipefail

# message in the user's language: Russian for a ru* locale, English otherwise (CLAUDE_PET_LANG=ru|en overrides)
case "${CLAUDE_PET_LANG:-${LC_ALL:-${LANG:-}}}" in ru*) _ru=1 ;; *) _ru=0 ;; esac
m() { if [ "$_ru" = 1 ]; then printf '%s' "$1"; else printf '%s' "$2"; fi; }


here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
pet="$here/pet-claude.py"
rc="${CLAUDE_PET_BASHRC:-$HOME/.bashrc}"
begin='# >>> claude-pet >>>'
end='# <<< claude-pet <<<'
mode=install; yes=0
for a in "$@"; do
  case "$a" in
    --uninstall) mode=uninstall ;;
    --print) mode=print ;;
    --yes|-y) yes=1 ;;
    -h|--help) sed -n '2,12p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "$(m "Неизвестный параметр" "Unknown option"): $a" >&2; exit 2 ;;
  esac
done

q() { printf "'%s'" "${1//\'/\'\\\'\'}"; }   # shell-quote a path (it may contain spaces)

block() {
  cat <<BLOCK
$begin
# Starts interactive \`claude\` sessions through the Claude Pet PTY wrapper so the pet can type into them.
# Bypass: \`command claude ...\`, \`\\claude ...\` or CLAUDE_PET_BYPASS=1 claude ...
claude() {
  local pet=$(q "$pet")

  # no wrapper when: bypass requested, already inside Claude Code / the wrapper, not a terminal, wrapper missing
  if [ -n "\$CLAUDE_PET_BYPASS" ] || [ -n "\$CLAUDECODE" ] || [ -n "\$PET_PTY_SOCK" ] \\
     || [ ! -t 0 ] || [ ! -t 1 ] || [ ! -f "\$pet" ]; then
    command claude "\$@"
    return
  fi

  # management subcommands are not sessions (a free-text first argument is a prompt and is wrapped)
  case "\$1" in
    agents|attach|auth|auto-mode|doctor|gateway|import|install|logs|mcp|plugin|plugins|purge|respawn|rm|setup-token|stop|kill|ultrareview|update|upgrade|migrate-installer)
      command claude "\$@"
      return
      ;;
  esac

  # one-shot / informational / background flags
  local a
  for a in "\$@"; do
    case "\$a" in
      -p|--print|-h|--help|-v|--version|--bg|--background)
        command claude "\$@"
        return
        ;;
    esac
  done

  python3 "\$pet" claude "\$@"
}
$end
BLOCK
}

if [ "$mode" = print ]; then block; exit 0; fi
[ -f "$pet" ] || { echo "$(m "Не найден" "Not found") $pet" >&2; exit 1; }

current=""; [ -f "$rc" ] && current="$(cat "$rc")"
has=0; grep -qxF "$begin" <<<"$current" && has=1

# the file without our block
without="$(awk -v b="$begin" -v e="$end" '$0==b{skip=1;next} $0==e{skip=0;next} !skip' <<<"$current")"
if [ "$mode" = install ]; then
  new="$without"
  [ -n "$new" ] && new="$new"$'\n\n'
  new="$new$(block)"
else
  [ "$has" = 1 ] || { echo "$(m "Интеграция не установлена: блока claude-pet в $rc нет." "Not installed: there is no claude-pet block in $rc.")"; exit 0; }
  new="$without"
fi

if [ "$new" = "$current" ]; then echo "$(m "Уже сделано, менять нечего ($rc)." "Already done, nothing to change ($rc).")"; exit 0; fi

echo "$(m "Изменения в $rc:" "Changes to $rc:")"
diff -u <(printf '%s\n' "$current") <(printf '%s\n' "$new") | tail -n +3 || true
echo
if [ "$yes" != 1 ]; then
  read -r -p "$(m "Применить? [y/N] " "Apply? [y/N] ")" ans
  case "$ans" in y|Y|yes|д|Д) ;; *) echo "$(m "Отменено, файл не изменён." "Cancelled, the file is unchanged.")"; exit 0 ;; esac
fi

if [ -f "$rc" ]; then
  backup="$rc.bak-claude-pet-$(date +%Y%m%d-%H%M%S)"
  cp -p "$rc" "$backup"
  echo "$(m "Резервная копия" "Backup"): $backup"
fi
tmp="$(mktemp "${rc}.XXXXXX")"
printf '%s\n' "$new" > "$tmp"
if [ -f "$rc" ]; then chmod --reference="$rc" "$tmp" 2>/dev/null || true; fi
mv "$tmp" "$rc"
if [ "$mode" = install ]; then
  echo "$(m "Готово. Откройте новое окно терминала: обычная команда \`claude\` теперь запускается через Claude Pet." "Done. Open a new terminal window: the plain \`claude\` command now runs through Claude Pet.")"
  echo "$(m "Откат" "Undo"): bash \"$here/install-shell-integration.sh\" --uninstall"
else
  echo "$(m "Готово: блок claude-pet удалён." "Done: the claude-pet block was removed.")"
fi
