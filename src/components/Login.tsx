import { useState } from 'react';
import { useStore } from '../store/useStore';

export default function Login() {
  const login = useStore((s) => s.login);
  const loginError = useStore((s) => s.loginError);
  const [username, setUsername] = useState('planner');
  const [password, setPassword] = useState('demo1234');

  return (
    <div className="login-wrap">
      <form
        className="login-card"
        onSubmit={(e) => {
          e.preventDefault();
          login(username.trim(), password);
        }}
      >
        <h1>区域急救药品库存与调拨分析</h1>
        <div className="sub">浏览器内本地推演 · 不连接真实医疗系统 · 演示环境</div>
        <div className="field">
          <label htmlFor="u">账号</label>
          <input
            id="u"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete="username"
          />
        </div>
        <div className="field">
          <label htmlFor="p">密码</label>
          <input
            id="p"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
          />
        </div>
        {loginError && <div className="notice error" style={{ marginBottom: 12 }}>{loginError}</div>}
        <button className="primary" style={{ width: '100%' }} type="submit">
          进入分析工作台
        </button>
        <div className="login-accounts">
          <div style={{ fontWeight: 650, color: '#33414f', marginBottom: 4 }}>演示账号</div>
          <div>计划员（可编辑/审批/签收）：<code>planner / demo1234</code></div>
          <div style={{ marginTop: 4 }}>只读观察员：<code>viewer / view1234</code></div>
        </div>
      </form>
    </div>
  );
}
