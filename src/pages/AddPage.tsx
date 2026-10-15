import { QuickAdd } from "../components/QuickAdd";
import { navigate } from "../lib/router";

export function AddPage() {
  return (
    <div className="page narrow">
      <h1 className="page-title">저장하기</h1>
      <p className="muted">링크나 글을 붙여넣으세요. 이 기기에 먼저 저장되고, PC에 연결되면 자동으로 정리돼요.</p>
      <QuickAdd rows={8} autoFocus onSaved={() => navigate("/", { replace: true })} />
      <div className="notice">
        <strong>더 빠르게 저장하는 방법</strong>
        <ul>
          <li>폰: 홈 화면에 앱을 설치하면 다른 앱의 공유 메뉴에 MemoReader가 나타나요.</li>
          <li>PC: 보관함 화면에서 Ctrl+V 로 붙여넣으면 바로 저장돼요.</li>
          <li>텔레그램: 설정에서 봇을 연결하면 봇에게 보내기만 해도 저장돼요.</li>
        </ul>
      </div>
    </div>
  );
}
