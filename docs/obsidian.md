# Obsidian과 함께 쓰기

MemoReader가 저장하는 폴더(`vault_output`)는 그대로 Obsidian 보관소(vault)로 열 수 있다.

## 폴더 위치

- 기본값: `C:\Claude\MemoReader\data\vault_output`
- 바꾸려면 PC의 `.env`에 `VAULT_DIR=D:\내\보관소\MemoReader` 처럼 적고 서버를 다시 시작한다 (`stop.bat` 후 `start.bat`). 기존 vault 안의 한 폴더를 지정해도 된다.
- 현재 위치는 앱의 설정 화면 "저장 위치 (Obsidian)"에서 볼 수 있다.
- 예전 버전의 `data\items`가 있으면 서버가 시작할 때 `vault_output`으로 한 번 옮긴다.

## Obsidian에서 열기

1. Obsidian → "폴더를 보관소로 열기" → 위 폴더 선택. (이미 쓰는 vault가 있다면 `VAULT_DIR`을 그 안의 폴더로 지정)
2. 메모는 `카테고리\제목 (id).md` 로 정리되어 있고, 카테고리에 `/`가 있으면 하위 폴더가 된다. 정리 전 메모는 `_inbox\` 에 있다.

## 파일 구조

```text
---
id: "20261012-212142-3072cf"
status: "done"
url: "https://..."
title: "..."
summary: "...\n..."
category: "AI 활용법"
tags: ["클로드","모션디자인","영상제작"]     ← Obsidian 속성(properties)과 태그로 인식됨
createdAt / updatedAt / source / favorite ...
inputStart / inputLength / pageStart / pageLength  ← 앱이 원문을 정확히 읽기 위한 위치 정보 (지우지 말 것)
---

# 제목
[도메인](링크)
![](대표 이미지)          ← 읽기 화면에서 미리보기로 보임

## 요약
## 원문          (사용자가 저장한 글, 가공되지 않음)
## 링크 본문     (PC가 가져온 페이지 텍스트)
```

- 태그는 Obsidian 태그 규칙(공백·특수문자 없음, 숫자만은 불가)에 맞게 저장된다. 예: `예약 도메인` → `예약-도메인`.
- 파일 이름에서 Obsidian이 링크로 못 쓰는 문자(`# ^ [ ] |`)와 Windows 금지 문자는 공백으로 바뀐다.

## 지켜 주면 좋은 것

- **앱이 쓴 노트는 앱에서 고친다.** 같은 메모를 앱에서 수정하거나 PC가 다시 정리하면 파일이 다시 쓰이므로, Obsidian에서 직접 고친 내용이 덮어써질 수 있다. Obsidian은 보고 찾고 연결하는 용도로 쓰는 것을 권한다.
- Obsidian이 만드는 `.obsidian`, `.trash` 폴더와 내가 따로 쓰는 노트(앱이 만든 `id`가 없는 노트)는 앱이 읽지도 지우지도 않는다.
- 파일 이름을 직접 바꿔도 앱은 파일 안의 `id`로 찾으므로 문제없지만, 앱이 다음에 그 메모를 수정하면 이름이 `제목 (id).md` 형식으로 다시 맞춰진다.
- 앱이 꺼진 동안 Obsidian에서 만든 변경은 동기화 대상이 아니다(폰에는 전달되지 않는다).
