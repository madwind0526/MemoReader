# State

## Current Wave

- **Wave:** 8
- **Status:** Ready
- **Cache Status:** CLEAN
- **Last Checkpoint:** Wave 7 완료 (테스트 65/65, 카톡 가져오기·Obsidian 합치기·카테고리 통합·죽은 링크 삭제)

## Wave History

| Wave | 작업 내용 | 상태 |
|------|-----------|------|
| 1 | 프로젝트 초기화 + 로컬 우선 PWA/백엔드 구현 (저장, 본문 수집, LLM 정리, 카테고리 폴더 이동, 동기화, 텔레그램 봇, Tailscale 인증) | Done |
| 2 | 간헐 부팅 PC 대응: 시작 시 백로그 처리, LLM 설정 시 실패 항목 재시도, 텔레그램 발신 시각 보존, Web Push로 닫힌 폰 깨우기(서비스 워커 동기화), 자동 시작 스크립트 | Done |
| 3 | 실기기 배포·검증: Tailscale(serve, 접근 허용 계정 제한), 자동 시작 작업 등록(관리자 권한 불필요 방식으로 수정), 푸시 진단 기능·재시도 확대, 폰 end-to-end 확인 | Done |

| 4 | PC 화면 개편(카테고리 트리·카드/리스트/메시·팝업·아이콘·미리보기), Obsidian 호환 저장(vault_output, 파일명·태그 규칙, 이전 레이아웃 이동), 같은 링크 합치기, 태그 10개 | Done |

| 5 | 정리 속도(claude 호출 가볍게), 카테고리 합치기, 실패만 다시 정리 버튼, 정렬 막대(메모·카테고리), 호버 효과 완화, CLI 오류 이유 표시 | Done |

| 6 | LLM 폴백 체인(Claude → Codex → OpenCode → Ollama), 원문 게시 날짜(publishedAt) 추출·표시·정렬·백필 | Done |

| 7 | 카톡 가져오기(화면, PC 전용), Obsidian 합치기(정션), 카테고리 5개 통합, 죽은 링크 삭제, 텔레그램 재연결 개선, 정리 제공업체 전환(OpenCode) | Done |

## Session Notes

- Wave 1~3 발견사항은 knowledge/ 로 flush 완료
- 텔레그램 실수신, 폰 공유 메뉴 저장은 미검증 (trouble-shooting.md 마지막 항목 참고)
