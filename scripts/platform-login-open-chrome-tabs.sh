#!/usr/bin/env bash
set -euo pipefail

ONLY="${1:-wechat_official,bilibili,weibo,zhihu,douyin,kuaishou,video_channel,jike}"

url_for() {
  case "$1" in
    wechat_official) echo "https://mp.weixin.qq.com/" ;;
    bilibili) echo "https://passport.bilibili.com/login" ;;
    weibo) echo "https://weibo.com/newlogin?tabtype=weibo&gid=102803&openLoginLayer=0&url=https://weibo.com/" ;;
    zhihu) echo "https://www.zhihu.com/signin?next=%2F" ;;
    douyin) echo "https://creator.douyin.com/creator-micro/content/post/create" ;;
    kuaishou) echo "https://cp.kuaishou.com/article/publish/video" ;;
    video_channel) echo "https://channels.weixin.qq.com/login.html" ;;
    jike) echo "https://web.okjike.com/login?redirect=https%3A%2F%2Fweb.okjike.com%2F" ;;
    xiaohongshu) echo "https://creator.xiaohongshu.com/publish/publish" ;;
    *) return 1 ;;
  esac
}

TAB_URLS=()
IFS=',' read -r -a IDS <<<"$ONLY"
for id in "${IDS[@]}"; do
  id="$(echo "$id" | xargs)"
  [[ -z "$id" ]] && continue
  if url="$(url_for "$id" 2>/dev/null)"; then
    TAB_URLS+=("$url")
  else
    echo "skip_unknown_platform: $id" >&2
  fi
done

if [[ "${#TAB_URLS[@]}" -eq 0 ]]; then
  echo "no_valid_platforms"
  exit 1
fi

APPLESCRIPT='tell application "Google Chrome"
  if it is not running then
    error "chrome_not_running"
  end if
  if (count of windows) = 0 then
    error "chrome_no_window"
  end if
  activate
  tell front window
'

for url in "${TAB_URLS[@]}"; do
  APPLESCRIPT+="
    make new tab with properties {URL:\"$url\"}"
done

APPLESCRIPT+='
  end tell
end tell'

osascript -e "$APPLESCRIPT" >/dev/null
echo "opened_tabs=${#TAB_URLS[@]}"
