import React, { useState } from 'react';
import { Layout, Menu, Avatar, Dropdown, Badge, Space, Typography } from 'antd';
import {
  DashboardOutlined,
  CarOutlined,
  UserOutlined,
  ShoppingCartOutlined,
  BarChartOutlined,
  SettingOutlined,
  LogoutOutlined,
  MenuFoldOutlined,
  MenuUnfoldOutlined,
  BellOutlined,
  TeamOutlined,
} from '@ant-design/icons';
import { Outlet, useNavigate, useLocation } from 'react-router-dom';
import { useDispatch, useSelector } from 'react-redux';
import { logout } from '../store/slices/authSlice';
import { type RootState, type AppDispatch } from '../store';

const { Header, Sider, Content } = Layout;
const { Text } = Typography;

const MainLayout: React.FC = () => {
  const [collapsed, setCollapsed] = useState(false);
  const navigate = useNavigate();
  const location = useLocation();
  const dispatch = useDispatch<AppDispatch>();
  const { admin } = useSelector((state: RootState) => state.auth);

  const handleLogout = async () => {
    await dispatch(logout());
    navigate('/login');
  };

  const menuItems = [
    {
      key: '/dashboard',
      icon: <DashboardOutlined />,
      label: '儀表板',
    },
    {
      key: '/drivers',
      icon: <CarOutlined />,
      label: '司機管理',
    },
    {
      key: '/passengers',
      icon: <UserOutlined />,
      label: '乘客管理',
    },
    {
      key: '/orders',
      icon: <ShoppingCartOutlined />,
      label: '訂單管理',
    },
    {
      key: '/analytics',
      icon: <BarChartOutlined />,
      label: '數據分析',
    },
    {
      key: '/admins',
      icon: <TeamOutlined />,
      label: '管理員設定',
    },
  ];

  const userMenu = (
    <Menu>
      <Menu.Item key="profile">
        <Space>
          <UserOutlined />
          個人資料
        </Space>
      </Menu.Item>
      <Menu.Item key="settings">
        <Space>
          <SettingOutlined />
          系統設定
        </Space>
      </Menu.Item>
      <Menu.Divider />
      <Menu.Item key="logout" onClick={handleLogout}>
        <Space>
          <LogoutOutlined />
          登出
        </Space>
      </Menu.Item>
    </Menu>
  );

  return (
    <Layout style={{ minHeight: '100vh' }}>
      <Sider
        trigger={null}
        collapsible
        collapsed={collapsed}
        theme="dark"
        style={{
          overflow: 'auto',
          height: '100vh',
          position: 'fixed',
          left: 0,
          top: 0,
          bottom: 0,
        }}
      >
        <div style={{
          height: 64,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: '#fff',
        }}>
          {collapsed ? (
            <CarOutlined style={{ fontSize: 24 }} />
          ) : (
            <Text strong style={{ color: '#fff', fontSize: 18 }}>
              花蓮計程車
            </Text>
          )}
        </div>
        <Menu
          theme="dark"
          mode="inline"
          selectedKeys={[location.pathname]}
          items={menuItems}
          onClick={({ key }) => navigate(key)}
        />
      </Sider>

      <Layout style={{ marginLeft: collapsed ? 80 : 200, transition: 'all 0.2s' }}>
        <Header
          style={{
            padding: 0,
            background: '#fff',
            position: 'sticky',
            top: 0,
            zIndex: 999,
            boxShadow: '0 1px 4px rgba(0,21,41,.08)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center' }}>
            {React.createElement(collapsed ? MenuUnfoldOutlined : MenuFoldOutlined, {
              className: 'trigger',
              onClick: () => setCollapsed(!collapsed),
              style: {
                fontSize: 18,
                padding: '0 24px',
                cursor: 'pointer',
              },
            })}
          </div>

          <div style={{ paddingRight: 24, display: 'flex', alignItems: 'center', gap: 16 }}>
            <Badge count={5} size="small">
              <BellOutlined style={{ fontSize: 18, cursor: 'pointer' }} />
            </Badge>

            <Dropdown overlay={userMenu} placement="bottomRight" arrow>
              <Space style={{ cursor: 'pointer' }}>
                <Avatar style={{ backgroundColor: '#87d068' }} icon={<UserOutlined />} />
                <Text>{admin?.username || 'Admin'}</Text>
              </Space>
            </Dropdown>
          </div>
        </Header>

        <Content
          style={{
            margin: 24,
            minHeight: 280,
          }}
        >
          <Outlet />
        </Content>
      </Layout>
    </Layout>
  );
};

export default MainLayout;