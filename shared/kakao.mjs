// Reading a KakaoTalk "chat with myself" export and sorting its messages. Shared by the import screen
// (browser) and the command-line import script, so both screen the same way.
import { extractFirstUrl } from "./item.mjs";

// "2018년 5월 7일 오후 6:39, 미친바람 : text"  (the speaker is the user's own name in a self chat)
const MESSAGE = /^(\d{4})년 (\d{1,2})월 (\d{1,2})일 (오전|오후) (\d{1,2}):(\d{2}), ([^:]+?) : ?(.*)$/;
// A bare date line such as "2018년 5월 6일 오후 6:05" only repeats the next message's time.
const DATE_ONLY = /^\d{4}년 \d{1,2}월 \d{1,2}일 (오전|오후) \d{1,2}:\d{2}$/;
const SYSTEM_TEXT = /^(사진|동영상|이모티콘|파일|보이스톡|음성메시지)( \d+장)?$|^삭제된 메시지입니다/;

function toDate(year, month, day, meridiem, hour, minute) {
  let h = Number(hour) % 12;
  if (meridiem === "오후") h += 12;
  // The export is in the phone's local time, the same zone the browser and the PC use.
  return new Date(Number(year), Number(month) - 1, Number(day), h, Number(minute));
}

/** Messages in file order: [{ at: Date, text }]. Multi-line messages are joined; empty ones dropped. */
export function parseKakaoExport(raw) {
  const lines = String(raw).replace(/^﻿/, "").split(/\r?\n/);
  const messages = [];
  let current = null;
  for (const line of lines) {
    const match = MESSAGE.exec(line);
    if (match) {
      current = { at: toDate(...match.slice(1, 7)), text: match[8] };
      messages.push(current);
    } else if (DATE_ONLY.test(line)) {
      current = null; // the next real message line carries its own time
    } else if (current) {
      current.text += `\n${line}`;
    }
  }
  for (const message of messages) message.text = message.text.trim();
  return messages.filter((message) => message.text);
}

/** "link" has a web address, "long" is a longer text (prompt, article), "short" is a small note, "system" is a photo/deleted notice. */
export function classifyMessage(text, longChars = 150) {
  if (SYSTEM_TEXT.test(text)) return "system";
  if (extractFirstUrl(text)) return "link";
  return text.length >= longChars ? "long" : "short";
}

/** A one-line version of a message for lists. */
export function snippet(text, length = 110) {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > length ? `${flat.slice(0, length)}…` : flat;
}
