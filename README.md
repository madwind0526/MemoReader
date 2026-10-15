# MemoReader

웹/SNS를 보다가 참고할 만한 링크나 글을 저장하면, PC가 본문을 가져와 LLM으로 요약·태그(10개 안팎)·카테고리를 붙이고 카테고리 폴더에 정리해 주는 개인용 보관함. 원문은 그대로 함께 보관한다. 모바일·PC 어디서나 입력하고 볼 수 있으며, 폰 단독 / PC 단독 / 연동 세 가지로 동작한다. 저장 폴더는 그대로 Obsidian 보관소로 열 수 있다.

## 실행

```bash
npm install
start.bat            # 앱을 빌드하고 http://127.0.0.1:4313 에서 실행
start.bat dev        # 개발 모드 (API 자동 재시작 + Vite 핫 리로드, http://127.0.0.1:5182)
stop.bat             # 종료
npm test             # 백엔드·서비스 워커 테스트
npm run build        # 타입체크 + 프로덕션 빌드
```

처음 실행하면 설정 화면에서 LLM 제공업체를 고른다. 폰 접속은 [docs/setup-tailscale.md](docs/setup-tailscale.md), Obsidian 연동은 [docs/obsidian.md](docs/obsidian.md).

## 구조

```text
src/        React + TypeScript PWA (모바일·PC 공용, IndexedDB 로컬 저장 + 동기화)
backend/    Node 서버 (동기화 API, 본문 수집, LLM 정리, 텔레그램 봇, 푸시, Tailscale 인증)
shared/     서버·클라이언트 공용 로직 (ID, URL·태그 정규화, 정리 프롬프트/결과 검증)
public/     manifest, 아이콘
scripts/    아이콘 생성, 자동 시작 등록
test/       백엔드·저장 구조·서비스 워커 테스트
data/       vault_output(저장된 메모), runtime(설정) — gitignore, 개인 데이터
docs/       개요, 설치, Obsidian 문서
memory-bank/  프로젝트 컨텍스트와 지식
```

자세한 설계는 [docs/overview.md](docs/overview.md).
