import React from 'react';
import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router-dom';
import { Provider, useSelector } from 'react-redux';
import { ConfigProvider, App as AntdApp } from 'antd';
import zhTW from 'antd/locale/zh_TW';
import { store, type RootState } from './store';
import MainLayout from './layouts/MainLayout';
import Login from './pages/Login';
import Dashboard from './pages/Dashboard';
import Drivers from './pages/Drivers';
import Passengers from './pages/Passengers';
import Orders from './pages/Orders';
import Analytics from './pages/Analytics';
import AdminManagement from './pages/AdminManagement';
import './App.css';

// 私有路由組件
const PrivateRoute: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { isAuthenticated } = useSelector((state: RootState) => state.auth);
  return isAuthenticated ? <>{children}</> : <Navigate to="/login" />;
};

function AppContent() {
  return (
    <Router basename="/admin">
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route
          path="/"
          element={
            <PrivateRoute>
              <MainLayout />
            </PrivateRoute>
          }
        >
          <Route index element={<Navigate to="/dashboard" />} />
          <Route path="dashboard" element={<Dashboard />} />
          <Route path="drivers" element={<Drivers />} />
          <Route path="passengers" element={<Passengers />} />
          <Route path="orders" element={<Orders />} />
          <Route path="analytics" element={<Analytics />} />
          <Route path="admins" element={<AdminManagement />} />
        </Route>
      </Routes>
    </Router>
  );
}

function App() {
  return (
    <Provider store={store}>
      <ConfigProvider locale={zhTW}>
        <AntdApp>
          <AppContent />
        </AntdApp>
      </ConfigProvider>
    </Provider>
  );
}

export default App;