# Patterns

> 검증된 코드 패턴. 복붙 바로 가능한 형태로 유지.

## 로컬 우선 동기화 (last-writer-wins + tombstone + 커서)

**사용 시점:** 모바일/PC가 각자 독립적으로 쓰이다가 서버(허브)에 닿을 때 합쳐져야 할 때.

- 항목 ID는 기기에서 생성 (`shared/item.mjs`의 `newId`) → 충돌 없음
- 모든 변경은 `updatedAt` 갱신 (`nextStamp`: 이전 값보다 항상 커지게) + `dirty=1`
- push: dirty 항목/삭제를 서버로 → 서버는 `updatedAt`이 더 큰 쪽만 채택, 삭제는 tombstone으로 보관
- pull: 서버가 `"{updatedAt}|{id}"` 커서로 항목과 삭제를 한 스트림으로 페이지 단위 반환
- push 직후 `dirty` 해제는 "보낸 시점의 updatedAt과 같을 때만" (전송 중 재편집 보호)
- 서버가 바꾼 것(정리 결과)도 `updatedAt`이 올라가므로 기기들이 pull로 받는다
- 코드: `backend/store.mjs`(`upsertFromSync`, `remove`, `changesSince`), `src/lib/sync.ts`, `src/lib/db.ts`

## 원문을 바이트 그대로 보존하는 Markdown 저장

**사용 시점:** 사용자 원문 + 가공 결과를 한 파일에 담고, 원문이 마커 문자열과 같아도 깨지면 안 될 때.

- frontmatter 값은 전부 `JSON.stringify` (유효한 YAML, Obsidian 호환), 파싱은 줄마다 `JSON.parse`
- 본문 섹션은 마커 검색 대신 frontmatter의 `inputStart/inputLength/pageStart/pageLength` 오프셋으로 잘라냄
- 사람이 파일을 편집해 오프셋이 어긋나면 마커 검색으로 폴백 (`sliceSection`)
- 임시 파일에 쓰고 `rename`으로 교체 (`atomicWrite`)

## 카테고리 폴더로 이동하며 저장

**사용 시점:** 분류 결과에 따라 파일을 해당 폴더로 옮겨야 할 때.

- `categoryFolder("네트워크/DNS")` → `["네트워크","DNS"]` (최대 3단계, 금지 문자 치환, 예약어/`..` 방어, 빈 값은 `_inbox`)
- `writeEntry`: 새 위치에 먼저 쓰고 → 이전 파일 삭제 → 빈 폴더 정리 (`pruneEmptyFolders`)
- Windows/macOS는 대소문자만 다른 경로가 같은 파일이므로 `samePath`로 비교 (아니면 방금 쓴 파일을 지움)
- 로드 시 같은 id가 두 파일이면 `updatedAt`이 큰 쪽만 남김 (이동 중 크래시 복구)

## 푸시로 닫힌 PWA를 깨워 동기화 (Web Push + 서비스 워커)

**사용 시점:** 서버(PC)가 가끔만 켜지고, 앱이 닫힌 폰이 그때 알아서 동기화해야 할 때. 별도 중계 서버 없이 브라우저 벤더의 푸시 서비스만 쓴다.

- 서버: `web-push`로 VAPID 키 생성(`data/runtime/vapid.json`), 구독 저장, 시작 15초 뒤 `online` 푸시, 정리 큐가 비면 20초 묶음으로 `organized` 푸시 (`backend/push.mjs`, `app.mjs`)
- 구독 endpoint는 푸시 서비스 도메인만 허용 (`isAllowedEndpoint`)
- 서비스 워커는 별도 Vite 빌드(`vite.sw.config.ts`, iife 단일 파일 `dist/sw.js`)로 만들어 페이지와 같은 `syncCore.ts`를 공유 (`src/sw.ts`)
- push 이벤트는 반드시 알림을 보여야 하므로 먼저 `showNotification`, 동기화 후 같은 `tag`로 문구 갱신
- VPN이 아직 안 붙었을 수 있어 0 / 4초 / 10초 재시도
- 검증: 빌드된 `sw.js`를 `vm` + `fake-indexeddb`로 실행해 실제 백엔드에 연결 (`test/sw.test.mjs`)

## 같은 링크가 여러 경로로 들어올 때 하나로 합치기

**사용 시점:** 폰·텔레그램·PC가 아직 동기화되기 전에 같은 링크를 각자 저장할 수 있을 때.

- 서버 `store.foldInto`: 이미 있는 항목에 새 항목을 흡수 (원문은 `mergeInput`으로 둘 다 보존, 태그 합집합, 즐겨찾기 OR, createdAt은 이른 쪽)
- 흡수된 쪽의 id는 tombstone으로 은퇴시켜 모든 기기가 다음 동기화에서 중복본을 지움 (옛 사본을 다시 push해도 거부됨)
- 같은 텔레그램 메시지 재전달(`sourceRef` 동일)은 아무것도 바꾸지 않음
- 기기 안에서도 같은 링크를 다시 저장하면 `addItem`이 같은 규칙으로 글만 덧붙임

## Obsidian 보관소로 열 수 있는 저장 구조

**사용 시점:** 앱이 쓰는 폴더를 Obsidian과 공유해야 할 때.

- 파일명 `제목 (id 끝 6자).md` — `# ^ [ ] |`와 Windows 금지 문자는 공백으로, 제목이 바뀌면 파일도 이동 (`noteFileName`)
- 태그는 `normalizeTag`(공백·기호 → `-`, 숫자만은 제외)로 저장 시 항상 정규화, 옛 태그는 로드 시 한 번 고쳐 쓰고 `updatedAt`을 올려 기기에 전파
- 보관소 안의 `.`로 시작하는 폴더와 `id`가 없는 노트는 읽지도 지우지도 않음
- 동기화용 기록(tombstones)과 설정은 보관소 밖(`data/`, `data/runtime/`)
- 이전 레이아웃(`data/items`)은 시작 시 한 번 이동 (`migrateLegacyFolder`)

## 카테고리 트리 + 끌어서 이동 (PC)

- `categories.ts`: 카테고리 문자열을 `/`로 나눠 최대 3단계 트리와 하위 포함 개수를 만듦, 상위 선택 시 하위 글 포함 (`inCategory`)
- 필터(카테고리·태그·즐겨찾기/정리 필요)와 편집 요청(`edit=1`)은 모두 URL에 둠 → 뒤로 가기가 자연스럽게 동작, 팝업도 `/item/:id` 경로
- 카드/행은 링크와 버튼을 형제로 둠(링크 안에 버튼 금지), 링크는 `draggable={false}`로 두고 바깥 div가 드래그 소스, 드롭 대상은 사이드바 카테고리 행

## 카드·리스트 호버 효과 (살짝 떠오름)

- 효과는 `@media (hover: hover) and (pointer: fine) and (prefers-reduced-motion: no-preference)` 안에서만 적용 (터치·동작 줄이기에서는 꺼짐)
- 카드: `translateY(-3px)` + 부드러운 그림자 + 썸네일 `scale(1.03)`만. **기울기(rotate/perspective)는 넣지 않는다** — 처음엔 마우스 위치에 따라 최대 3도 기울였더니 모서리가 뒤틀려 보여 사용자가 너무 강하다고 해서 뺌 (요청)
- 리스트 행: `translateY(-1px)` + 그림자, 그림자가 잘리지 않도록 `.list-table`의 `overflow:hidden`을 없애고 첫/끝 행이 직접 모서리를 둥글게 함
- 시험 방법: 실제 포인터 이동(MCP `hover`)으로 확인 (가상 마우스 이벤트는 React의 enter/leave를 일으키지 않음)

## 정렬 막대 (SongYUE2 방식)와 정렬 선택 기억

- `SortBar`: 둥근 테두리 안의 아이콘 버튼 묶음, 맨 앞에 선택적 동작(새로고침) + 구분선, 선택된 정렬은 채워진 배경, `aria-pressed`·`title`로 설명
- 정렬 규칙은 `shared/sort.mjs`의 순수 함수(`sortItems`, `categoryComparator`)로 두어 브라우저와 테스트가 같이 씀 (한국어 `localeCompare`, 같은 값은 최신순으로 안정 정렬)
- 선택은 `createPreference`(localStorage + `useSyncExternalStore`)로 기억하고 사이드바·폰 메뉴 등 읽는 모든 곳이 같이 바뀜

## 실패한 것만 다시 정리

- `retryFailedItems()`는 `status === "failed"`만 한 번에 `pending`으로 바꿔 한 번의 동기화로 올림 (정상 메모의 `updatedAt`은 그대로)
- 서버는 대기열을 한 건씩만 처리 (동시 처리는 카테고리 이름이 갈릴 수 있어 의도적으로 하지 않음)
- 실패 원인이 설정 문제(LLM 미설정 등)면 설정을 고치는 순간 자동 재시도, 그 외 실패는 이 버튼으로 직접 재시도

## 메시 뷰 (태그 공유 그래프)

- SNS Reader 방식 포팅: 상위 18개 태그로만 연결, 균형 잡힌 간선 선택(노드당 상한 2→4→7, 최대 360개), 태그 선택 시 그 태그 간선만 강조
- 추가: 스프링 배치(노드 400개 이하)로 태그를 공유하는 글이 가까이 모이게 함, 카테고리별 색(`categoryHue`), 글 위치에 맞춘 초기 확대(`fitViewport`), 글이 12개 이하일 때만 제목 상시 표시
- 휠 확대는 네이티브 `wheel` 리스너(`passive:false`)로 처리하고, 드래그로 이동한 뒤에는 원 클릭을 무시
- 태그 빈도 패널은 항상 오른쪽, 컨테이너 쿼리(`@container lib`)와 `cqi` 단위로 폭·글자 크기를 줄임

## 서버가 임의 URL을 가져올 때 (SSRF 방어)

**사용 시점:** 사용자가 준 링크의 본문을 서버가 fetch할 때.

- `redirect: "manual"`로 홉마다 `assertPublicUrl` 재검증 (최대 5회)
- DNS 조회 결과가 사설/루프백/링크로컬/CGNAT(100.64/10 = Tailscale)/ULA면 거부
- 응답 2MB 상한, 15초 타임아웃, `text/html|plain`만 허용, charset은 헤더→meta 순으로 `TextDecoder`
- 코드: `backend/fetch-page.mjs`

## CLI LLM 호출 (claude / codex / opencode)

**사용 시점:** 로그인된 CLI를 API 키 없이 LLM으로 쓸 때.

- **claude는 가볍게 띄운다 (실측 18.7초 → 9.1초, 앱에서 메모당 평균 7.6초)**: `-p --strict-mcp-config --tools "" --disable-slash-commands --setting-sources project --system-prompt-file <임시파일>` + 메모는 stdin. 설치된 MCP 서버·플러그인·훅·스킬·기본 시스템 프롬프트를 불러오는 고정 비용이 시간의 대부분이었고, 작은 모델(haiku)로 바꿔도 빨라지지 않았음. 도구를 끄므로 페이지 본문이 무엇을 실행할 수도 없음 (`backend/llm.mjs`의 `askClaude`)
- `--bare`는 쓰지 않는다: OAuth/키체인 로그인을 읽지 않고 `ANTHROPIC_API_KEY`만 쓰므로 로그인된 CLI 방식이 깨짐
- 오래된 CLI가 옵션을 모르면(`unknown option`) 한 번만 실패하고 이후엔 기본 방식으로 자동 전환, 멈춘 호출은 90초 제한 후 1회 재시도
- 시스템 지시문은 인자가 아니라 **파일**로 전달하고 호출 뒤 삭제
- 프롬프트는 인자가 아니라 **stdin**으로 전달 (Windows `.cmd` 래퍼가 큰 인자를 망가뜨림)
- `cwd`는 `os.tmpdir()` (프로젝트의 CLAUDE.md가 답변에 섞이는 것 방지)
- `cross-spawn`으로 실행해 Windows 래퍼를 해석하되 인자는 argv로만 전달
- 코드: `backend/llm.mjs`

## LLM 폴백 체인 (토큰 부족·로그인 만료 대비)

**사용 시점:** 한 제공업체가 한도/로그인 문제로 실패해도 정리를 멈추지 않으려 할 때.

- 순서: 선택한 제공업체 → Claude → Codex → OpenCode → Ollama (중복 제외). 실패한 제공업체는 10분간 쉬고, 모두 쉬는 중이면 그래도 시도
- `accept` 검증기로 "답은 왔지만 JSON이 깨진" 경우도 다음 제공업체로 넘김. `limit|quota|usage|login` 류 오류는 같은 제공업체에 재시도하지 않음
- 모두 실패하면 제공업체별 실패 이유를 한 메시지로 합쳐 항목의 `error`에 표시, 체인 길이가 1이면 원래 오류를 그대로 전달
- 코드: `backend/llm.mjs`의 `createFallbackClient`, 설정 `llm.fallback`

## 원문 게시 날짜 (publishedAt)

**사용 시점:** 저장 시각이 아니라 원문이 올라온 시각으로 메모를 보여주고 정렬할 때.

- 우선순위: 주소에서 계산 > 페이지 메타(`article:published_time` 등)·JSON-LD·`<time datetime>`·Instagram 설명 문구 > 텔레그램 전달 시각 > LLM이 본문에서 읽은 명시적 날짜 (이미 있으면 덮어쓰지 않음)
- 주소 계산: Instagram/Threads 단축코드 `id>>23 + 1314220021721ms`, X 스노플레이크 `id>>22 + 1288834974657ms` (실제 페이지 날짜와 대조해 일치 확인)
- 저장 형식: 날짜만 알면 `YYYY-MM-DD`(시간대 이동 없이 달력 날짜로 표시), 시각까지 알면 UTC ISO. 연도만 있는 값·상대 표현("2일 전")·저장일보다 하루 넘게 뒤인 값은 버림
- 날짜가 없으면 저장 시각으로 표시 (`memoTime`), 정렬 `원문 날짜 순`도 같은 대체 규칙
- 이전 버전 기기가 필드 없이 push해도 서버의 기존 날짜는 지우지 않음
- 기존 메모 백필: `node scripts/backfill-published.mjs [--apply]` (LLM 없음, 적용 시 보관함 백업 후 sync push)
- 코드: `shared/item.mjs`, `backend/fetch-page.mjs`, `backend/organize.mjs`, `src/lib/ui.ts`

## 가져오기 화면 (PC 전용, 카카오톡 내보내기)

**사용 시점:** 오래된 메모(카카오톡 "나와의 채팅" 내보내기 파일)를 걸러서 한꺼번에 저장할 때.

- 흐름: 파일 선택(브라우저에서 읽음) → 걸러내기 버튼(링크/긴 글/짧은 글, 긴 글 기준 글자 수, 이미 저장한 링크 제외, 연도) → 후보 목록에서 개별 체크 → `N개 가져오기`. 버튼 조합 결과 위에 사용자의 수동 체크가 덮어씀(`overrides`)
- "AI로 일상 메모 걸러내기": 긴 글 25개씩 `POST /api/import/screen`(서버 LLM, 폴백 체인 사용)로 판단. 가족·이웃·할 일 등 일상 글은 제외, 사진·삭제된 메시지는 항상 제외
- 저장: `importItems`가 메시지 작성 시각을 저장 시각으로 쓰고, 같은 링크(기존 + 같은 파일 안)는 글을 합쳐 한 메모로. 상태는 `pending`이라 PC가 한 건씩 정리
- PC 전용: 메뉴는 사이드바(저장 아래)에만 있고 하단 탭바에는 없음. 폰에서 `/import`로 들어오면 안내만 표시
- 같은 규칙의 명령줄 버전: `node scripts/import-kakao.mjs <파일> [--apply]` (공용 코드 `shared/kakao.mjs`, `backend/screen.mjs`)
- 코드: `src/pages/ImportPage.tsx`, `src/lib/library.ts`(`importItems`)
