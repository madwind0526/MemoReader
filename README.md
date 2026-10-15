# MemoReader

웹/SNS를 보다가 참고할 만한 링크나 글을 저장하면, PC가 본문을 가져와 LLM으로 요약·태그(10개 안팎)·카테고리를 붙이고 카테고리 폴더에 정리해 주는 개인용 보관함. 원문은 그대로 함께 보관한다. 모바일·PC 어디서나 입력하고 볼 수 있으며, 폰 단독 / PC 단독 / 연동 세 가지로 동작한다. 저장 폴더는 그대로 Obsidian 보관소로 열 수 있다.

## 주요 기능

- **저장**: 폰 공유 메뉴, 붙여넣기(폰·PC), 텔레그램 봇, 가져오기 화면
- **자동 정리**: 링크 본문 수집 → LLM이 제목·요약·태그·카테고리 작성 → Markdown 파일로 저장. 정리는 PC가 한 건씩 진행하고, PC가 꺼져 있던 동안 쌓인 것은 켜질 때 이어서 처리
- **JS가 필요한 페이지**: 설치된 Chrome/Edge를 헤드리스로 띄워 읽음. 로그인 벽이면 설정 화면에 저장한 쿠키로 해당 사이트만 한 번 더 읽음(같은 사이트 사이 10~16초 간격)
- **동기화**: 마지막 수정 시각 기준(last-writer-wins), 삭제 기록, 커서 방식. 서버가 변경을 서버 전송 이벤트(SSE)로 알려 화면이 바로 갱신되고, 앱이 닫혀 있으면 웹 푸시로 깨움
- **보기**: 카드·리스트·메시(태그 연결망), 검색, 즐겨찾기, 날짜 정렬(등록 날짜순·원문 날짜순, 클릭할 때마다 오름/내림)
- **가져오기(PC)**: 카카오톡 "나와의 채팅" 내보내기, 텍스트·마크다운, 블로그 백업(HTML·XML), JSON 파일. 저장할 만한 글만 걸러서 가져오고 글 날짜가 메모 날짜가 됨

## 카테고리

`PC` · `AI` · `ComfyUI` · `생활` · `영화` · `투자` · `SNS` · `기타` (정의는 `shared/taxonomy.mjs`)

`SNS`는 다른 주제에 맞지 않는 일반 글만 들어가고, 하위 폴더 `페북` · `인스타` · `쓰레드` · `블로그` · `ETC`는 링크 주소로 정한다.

## 실행

```bash
npm install
start.bat            # 앱을 빌드하고 http://127.0.0.1:4313 에서 실행
start.bat dev        # 개발 모드 (API 자동 재시작 + Vite 핫 리로드, http://127.0.0.1:5182)
stop.bat             # 종료
npm test             # 백엔드·서비스 워커 테스트
npm run build        # 타입체크 + 프로덕션 빌드
```

처음부터 설치하는 순서(Node, LLM 연결, 자동 시작, Tailscale, 폰 설치, 텔레그램, 쿠키)는 **[docs/install.md](docs/install.md)** 를 따라 하면 된다.

처음 실행하면 설정 화면에서 LLM 제공업체를 고른다(claude-cli, codex-cli, opencode-cli, ollama, anthropic, openai, gemini). 실패하면 다음 제공업체로 자동 전환된다. 폰 접속은 [docs/setup-tailscale.md](docs/setup-tailscale.md), Obsidian 연동은 [docs/obsidian.md](docs/obsidian.md). 환경 변수는 `.env.example` 참고.

## 구조

```text
src/        React + TypeScript PWA (모바일·PC 공용, IndexedDB 로컬 저장 + 동기화)
backend/    Node 서버 (동기화 API, 본문 수집·브라우저 렌더링, LLM 정리, 텔레그램 봇, 푸시, Tailscale 인증)
shared/     서버·클라이언트 공용 로직 (ID, URL·태그 정규화, 카테고리, 정리 프롬프트/결과 검증, 가져오기 파서, 정렬)
public/     manifest, 아이콘
scripts/    유지보수 스크립트, 자동 시작 등록
test/       백엔드·저장 구조·서비스 워커 테스트
data/       vault_output(저장된 메모), runtime(설정·쿠키) — gitignore, 개인 데이터
docs/       개요, 설치, Obsidian 문서
memory-bank/  프로젝트 컨텍스트와 지식
```

## 유지보수 스크립트

모두 기본은 미리보기(dry run)이고, `--apply`를 붙이면 보관함을 백업한 뒤 반영한다.

| 스크립트 | 하는 일 |
|---|---|
| `scripts/split-other.mjs` | `기타`·`생활` 메모를 영화·투자·SNS 등으로 재분류 (판단을 `data/runtime/split-plan.json`에 저장하고 적용은 그 파일 그대로) |
| `scripts/remove-unreadable.mjs` | 접속 불가·로그인 화면·페이지 없음·오류 페이지·네이버 블로그를 읽지 못한 `기타` 메모 삭제 |
| `scripts/reread-thin.mjs` | 본문이 짧게만 저장된 메모를 브라우저로 다시 읽도록 대기열에 넣음 (`--host`로 사이트 지정) |
| `scripts/remove-dead.mjs` | 서비스 종료 안내·삭제된 글·재생 불가 YouTube 삭제 |
| `scripts/recategorize.mjs` | 예전 세부 카테고리를 현재 분류로 정리 |
| `scripts/backfill-published.mjs` | 기존 메모의 원문 날짜 채우기 |
| `scripts/import-kakao.mjs`, `import-obsidian.mjs` | 카카오톡·Obsidian 보관함을 명령줄로 가져오기 |
| `scripts/autostart-install.bat` / `autostart-remove.bat` | 로그온 시 자동 시작 등록·해제 |

## 개인 정보

`data/`(메모 본문, 설정, 봇 토큰, 로그인 쿠키)는 저장소에 올라가지 않는다. 접근은 Tailscale 계정으로만 허용하고 서버는 루프백에만 바인딩한다.

자세한 설계는 [docs/overview.md](docs/overview.md).
