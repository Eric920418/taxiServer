import React, { useState, useEffect, useCallback } from 'react';
import {
  Drawer,
  List,
  Badge,
  Tag,
  Typography,
  Button,
  Space,
  Empty,
  Tabs,
  Spin,
  message,
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
  ReloadOutlined,
} from '@ant-design/icons';
import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';
import 'dayjs/locale/zh-tw';
import { notificationAPI } from '../services/api';

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
  onUnreadCountChange?: (count: number) => void;
}

const NotificationCenter: React.FC<NotificationCenterProps> = ({
  visible,
  onClose,
  onUnreadCountChange
}) => {
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [loading, setLoading] = useState(false);
  const [activeTab, setActiveTab] = useState('all');
  const [unreadCount, setUnreadCount] = useState(0);

  // 載入通知
  const loadNotifications = useCallback(async () => {
    setLoading(true);
    try {
      const response = await notificationAPI.getNotifications(
        activeTab === 'all' || activeTab === 'unread' ? undefined : activeTab,
        activeTab === 'unread' ? true : undefined,
        100
      );
      if (response.success) {
        setNotifications(response.data || []);
        setUnreadCount(response.unreadCount || 0);
        onUnreadCountChange?.(response.unreadCount || 0);
      }
    } catch (error) {
      console.error('Failed to load notifications:', error);
    } finally {
      setLoading(false);
    }
  }, [activeTab, onUnreadCountChange]);

  useEffect(() => {
    if (visible) {
      loadNotifications();
    }
  }, [visible, loadNotifications]);

  // 定期更新未讀數量
  useEffect(() => {
    const checkUnread = async () => {
      try {
        const response = await notificationAPI.getNotifications(undefined, true, 1);
        if (response.success) {
          setUnreadCount(response.unreadCount || 0);
          onUnreadCountChange?.(response.unreadCount || 0);
        }
      } catch (error) {
        // 靜默失敗
      }
    };

    const interval = setInterval(checkUnread, 30000);
    return () => clearInterval(interval);
  }, [onUnreadCountChange]);

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

  const handleMarkAsRead = async (id: string) => {
    try {
      const response = await notificationAPI.markAsRead(id);
      if (response.success) {
        setNotifications(notifications.map(n =>
          n.id === id ? { ...n, read: true } : n
        ));
        setUnreadCount(prev => Math.max(0, prev - 1));
        onUnreadCountChange?.(Math.max(0, unreadCount - 1));
      }
    } catch (error) {
      message.error('標記失敗');
    }
  };

  const handleMarkAllAsRead = async () => {
    try {
      const response = await notificationAPI.markAllAsRead();
      if (response.success) {
        setNotifications(notifications.map(n => ({ ...n, read: true })));
        setUnreadCount(0);
        onUnreadCountChange?.(0);
        message.success('已全部標為已讀');
      }
    } catch (error) {
      message.error('操作失敗');
    }
  };

  const handleDelete = async (id: string) => {
    try {
      const response = await notificationAPI.deleteNotification(id);
      if (response.success) {
        const deletedNotification = notifications.find(n => n.id === id);
        setNotifications(notifications.filter(n => n.id !== id));
        if (deletedNotification && !deletedNotification.read) {
          setUnreadCount(prev => Math.max(0, prev - 1));
          onUnreadCountChange?.(Math.max(0, unreadCount - 1));
        }
      }
    } catch (error) {
      message.error('刪除失敗');
    }
  };

  const handleClearAll = async () => {
    try {
      const response = await notificationAPI.clearAll();
      if (response.success) {
        setNotifications([]);
        setUnreadCount(0);
        onUnreadCountChange?.(0);
        message.success('已清空所有通知');
      }
    } catch (error) {
      message.error('操作失敗');
    }
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
      open={visible}
      onClose={onClose}
      extra={
        <Space>
          <Button
            size="small"
            icon={<ReloadOutlined />}
            onClick={loadNotifications}
            loading={loading}
          >
            重新整理
          </Button>
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
        onChange={(key) => {
          setActiveTab(key);
        }}
        items={tabItems}
        style={{ marginBottom: 16 }}
      />

      <Spin spinning={loading}>
        {filteredNotifications.length === 0 ? (
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description={loading ? '載入中...' : '暫無通知'}
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
      </Spin>
    </Drawer>
  );
};

export default NotificationCenter;
