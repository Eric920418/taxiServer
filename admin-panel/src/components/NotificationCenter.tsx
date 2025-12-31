import React, { useState } from 'react';
import {
  Drawer,
  List,
  Badge,
  Tag,
  Typography,
  Button,
  Space,
  Empty,
  Divider,
  Tabs,
} from 'antd';
import {
  BellOutlined,
  CheckOutlined,
  DeleteOutlined,
  ExclamationCircleOutlined,
  InfoCircleOutlined,
  WarningOutlined,
  CarOutlined,
  UserOutlined,
  ShoppingCartOutlined,
} from '@ant-design/icons';
import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';
import 'dayjs/locale/zh-tw';

dayjs.extend(relativeTime);
dayjs.locale('zh-tw');

const { Text } = Typography;

interface Notification {
  id: string;
  type: 'info' | 'warning' | 'error' | 'success';
  category: 'order' | 'driver' | 'passenger' | 'system';
  title: string;
  message: string;
  time: string;
  read: boolean;
  link?: string;
}

interface NotificationCenterProps {
  visible: boolean;
  onClose: () => void;
}

const NotificationCenter: React.FC<NotificationCenterProps> = ({ visible, onClose }) => {
  const [notifications, setNotifications] = useState<Notification[]>([
    {
      id: '1',
      type: 'warning',
      category: 'order',
      title: '訂單糾紛',
      message: '訂單 #ORD123456 收到乘客投訴，請儘快處理',
      time: '2025-11-12T10:30:00',
      read: false,
    },
    {
      id: '2',
      type: 'info',
      category: 'driver',
      title: '新司機註冊',
      message: '司機 李師傅 已提交註冊申請，等待審核',
      time: '2025-11-12T10:15:00',
      read: false,
    },
    {
      id: '3',
      type: 'error',
      category: 'system',
      title: '系統警告',
      message: '伺服器 CPU 使用率超過 85%，請檢查系統狀態',
      time: '2025-11-12T09:45:00',
      read: false,
    },
    {
      id: '4',
      type: 'success',
      category: 'passenger',
      title: '乘客評價',
      message: '收到 5 則新的 5 星評價',
      time: '2025-11-12T09:30:00',
      read: true,
    },
    {
      id: '5',
      type: 'info',
      category: 'order',
      title: '訂單高峰',
      message: '當前訂單數量激增，建議增加派單效率',
      time: '2025-11-12T08:00:00',
      read: true,
    },
    {
      id: '6',
      type: 'warning',
      category: 'driver',
      title: '司機評分過低',
      message: '司機 張師傅 近期評分降至 3.2 星，請關注',
      time: '2025-11-11T18:20:00',
      read: true,
    },
  ]);

  const [activeTab, setActiveTab] = useState('all');

  const getNotificationIcon = (type: string) => {
    const iconMap: { [key: string]: React.ReactNode } = {
      info: <InfoCircleOutlined style={{ color: '#1890ff' }} />,
      warning: <WarningOutlined style={{ color: '#faad14' }} />,
      error: <ExclamationCircleOutlined style={{ color: '#ff4d4f' }} />,
      success: <CheckOutlined style={{ color: '#52c41a' }} />,
    };
    return iconMap[type] || <BellOutlined />;
  };

  const getCategoryIcon = (category: string) => {
    const iconMap: { [key: string]: React.ReactNode } = {
      order: <ShoppingCartOutlined />,
      driver: <CarOutlined />,
      passenger: <UserOutlined />,
      system: <BellOutlined />,
    };
    return iconMap[category];
  };

  const getCategoryColor = (category: string) => {
    const colorMap: { [key: string]: string } = {
      order: 'blue',
      driver: 'green',
      passenger: 'purple',
      system: 'orange',
    };
    return colorMap[category] || 'default';
  };

  const getCategoryText = (category: string) => {
    const textMap: { [key: string]: string } = {
      order: '訂單',
      driver: '司機',
      passenger: '乘客',
      system: '系統',
    };
    return textMap[category] || category;
  };

  const handleMarkAsRead = (id: string) => {
    setNotifications(notifications.map(n =>
      n.id === id ? { ...n, read: true } : n
    ));
  };

  const handleMarkAllAsRead = () => {
    setNotifications(notifications.map(n => ({ ...n, read: true })));
  };

  const handleDelete = (id: string) => {
    setNotifications(notifications.filter(n => n.id !== id));
  };

  const handleClearAll = () => {
    setNotifications([]);
  };

  const getFilteredNotifications = () => {
    if (activeTab === 'all') {
      return notifications;
    } else if (activeTab === 'unread') {
      return notifications.filter(n => !n.read);
    } else {
      return notifications.filter(n => n.category === activeTab);
    }
  };

  const unreadCount = notifications.filter(n => !n.read).length;
  const filteredNotifications = getFilteredNotifications();

  const tabItems = [
    {
      key: 'all',
      label: `全部 (${notifications.length})`,
    },
    {
      key: 'unread',
      label: (
        <Badge count={unreadCount} offset={[10, 0]}>
          <span>未讀</span>
        </Badge>
      ),
    },
    {
      key: 'order',
      label: `訂單`,
    },
    {
      key: 'driver',
      label: `司機`,
    },
    {
      key: 'passenger',
      label: `乘客`,
    },
    {
      key: 'system',
      label: `系統`,
    },
  ];

  return (
    <Drawer
      title={
        <Space>
          <BellOutlined />
          <span>通知中心</span>
          {unreadCount > 0 && (
            <Badge count={unreadCount} style={{ backgroundColor: '#52c41a' }} />
          )}
        </Space>
      }
      width={500}
      visible={visible}
      onClose={onClose}
      extra={
        <Space>
          {unreadCount > 0 && (
            <Button size="small" onClick={handleMarkAllAsRead}>
              全部標為已讀
            </Button>
          )}
          <Button size="small" danger onClick={handleClearAll}>
            清空全部
          </Button>
        </Space>
      }
    >
      <Tabs
        activeKey={activeTab}
        onChange={setActiveTab}
        items={tabItems}
        style={{ marginBottom: 16 }}
      />

      {filteredNotifications.length === 0 ? (
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description="暫無通知"
          style={{ marginTop: 60 }}
        />
      ) : (
        <List
          dataSource={filteredNotifications}
          renderItem={(item) => (
            <List.Item
              style={{
                backgroundColor: item.read ? 'transparent' : '#f0f5ff',
                padding: '16px',
                borderRadius: '8px',
                marginBottom: '8px',
                border: item.read ? 'none' : '1px solid #d6e4ff',
              }}
              actions={[
                !item.read && (
                  <Button
                    type="link"
                    size="small"
                    icon={<CheckOutlined />}
                    onClick={() => handleMarkAsRead(item.id)}
                  >
                    標為已讀
                  </Button>
                ),
                <Button
                  type="link"
                  size="small"
                  danger
                  icon={<DeleteOutlined />}
                  onClick={() => handleDelete(item.id)}
                >
                  刪除
                </Button>,
              ].filter(Boolean)}
            >
              <List.Item.Meta
                avatar={
                  <div style={{ fontSize: 24 }}>
                    {getNotificationIcon(item.type)}
                  </div>
                }
                title={
                  <Space>
                    <Text strong style={{ fontSize: 14 }}>
                      {item.title}
                    </Text>
                    <Tag
                      icon={getCategoryIcon(item.category)}
                      color={getCategoryColor(item.category)}
                    >
                      {getCategoryText(item.category)}
                    </Tag>
                    {!item.read && <Badge status="processing" />}
                  </Space>
                }
                description={
                  <div>
                    <Text>{item.message}</Text>
                    <br />
                    <Text type="secondary" style={{ fontSize: 12 }}>
                      {dayjs(item.time).fromNow()}
                    </Text>
                  </div>
                }
              />
            </List.Item>
          )}
        />
      )}
    </Drawer>
  );
};

export default NotificationCenter;
