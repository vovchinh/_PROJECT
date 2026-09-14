import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import './styles.css';

class ErrorBoundary extends React.Component {
  state = { error: null };
  static getDerivedStateFromError(error) {
    return { error };
  }
  render() {
    return this.state.error ? (
      <main className="fatal">
        <h1>Không thể hiển thị trang</h1>
        <p>
          Dữ liệu chưa bị xóa. Hãy tải lại trang; nếu lỗi còn lặp lại, lưu nội dung lỗi để kiểm tra.
        </p>
        <pre>{this.state.error.message}</pre>
        <button onClick={() => location.reload()}>Tải lại</button>
      </main>
    ) : (
      this.props.children
    );
  }
}
createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
);
