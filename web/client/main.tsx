import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App';
import { DialogProvider, NoticeProvider } from './ui';
import './styles.css';

class ErrorBoundary extends React.Component<{ children: React.ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() {
    if (this.state.failed) return <div className="boot-screen"><h1>页面暂时遇到了问题</h1><p>你的项目保存在服务器上。请刷新页面后重试。</p><button className="button primary" onClick={() => window.location.reload()}>重新加载</button></div>;
    return this.props.children;
  }
}
ReactDOM.createRoot(document.getElementById('root')!).render(<ErrorBoundary><NoticeProvider><DialogProvider><App /></DialogProvider></NoticeProvider></ErrorBoundary>);
