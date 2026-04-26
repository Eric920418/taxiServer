import React, { useEffect, useState } from 'react';
import {
  Card,
  Table,
  Button,
  Space,
  Tag,
  Modal,
  Form,
  Input,
  Typography,
  App as AntdApp,
  Empty,
  Statistic,
  Row,
  Col,
  Tooltip,
} from 'antd';
import {
  StopOutlined,
  ReloadOutlined,
  RollbackOutlined,
  ExclamationCircleOutlined,
  UserOutlined,
} from '@ant-design/icons';
import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';
import 'dayjs/locale/zh-tw';
import { passengerBlacklistAPI } from '../services/api';

dayjs.extend(relativeTime);
dayjs.locale('zh-tw');

const { Title, Text } = Typography;

interface BlacklistRow {
  passengerId: string;
  name: string;
  phoneNumber: string;
  blacklistReason: string;
  blacklistedAt: string;
  blacklistedBy: string;
  noShowCount: number;
  lastNoShowAt: string | null;
}

const Blacklist: React.FC = () => {
  const { message } = AntdApp.useApp();
  const [rows, setRows] = useState<BlacklistRow[]>([]);
  const [loading, setLoading] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const r = await passengerBlacklistAPI.getBlacklisted();
      if (r.success) setRows(r.data ?? []);
    } catch (e) {
      console.error('[Blacklist] load failed:', e);
      message.error('黑名單列表載入失敗');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const handleUnblacklist = (row: BlacklistRow) => {
    Modal.confirm({
      title: '確認移除黑名單？',
      icon: <ExclamationCircleOutlined />,
      content: `將解除對 ${row.name || row.passengerId} 的派單限制，未來可正常叫車。`,
      okText: '解除',
      cancelText: '取消',
      onOk: async () => {
        try {
          const r = await passengerBlacklistAPI.unblacklist(row.passengerId);
          if (r.success) {
            message.success('已解除黑名單');
            load();
          } else {
            message.error(r.error || '解除失敗');
          }
        } catch (e: any) {
          message.error(e?.response?.data?.error || '解除失敗');
        }
      },
    });
  };

  // 顯示電話：隱藏 LINE_/PHONE_ 假電話
  const renderPhone = (p: string) => {
    if (!p) return <Text type="secondary">—</Text>;
    if (p.startsWith('LINE_')) return <Tag color="green">LINE 用戶</Tag>;
    if (p.startsWith('PHONE_')) return <Tag color="orange">電話訂單</Tag>;
    return <Text>{p}</Text>;
  };

  const columns = [
    {
      title: '加入時間',
      dataIndex: 'blacklistedAt',
      key: 'blacklistedAt',
      width: 160,
      render: (t: string) => (
        <Space direction="vertical" size={0}>
          <Text>{dayjs(t).format('YYYY-MM-DD HH:mm')}</Text>
          <Text type="secondary" style={{ fontSize: 12 }}>{dayjs(t).fromNow()}</Text>
        </Space>
      ),
      sorter: (a: BlacklistRow, b: BlacklistRow) =>
        dayjs(a.blacklistedAt).valueOf() - dayjs(b.blacklistedAt).valueOf(),
      defaultSortOrder: 'descend' as const,
    },
    {
      title: '乘客',
      key: 'passenger',
      render: (_: any, row: BlacklistRow) => (
        <Space direction="vertical" size={0}>
          <Text strong>
            <UserOutlined /> {row.name || '未命名'}
          </Text>
          {renderPhone(row.phoneNumber)}
          <Text type="secondary" style={{ fontSize: 12 }}>{row.passengerId}</Text>
        </Space>
      ),
    },
    {
      title: '黑名單原因',
      dataIndex: 'blacklistReason',
      key: 'blacklistReason',
      ellipsis: true,
      render: (r: string) => (
        <Tooltip title={r}>
          <Text>{r}</Text>
        </Tooltip>
      ),
    },
    {
      title: '累計未到',
      dataIndex: 'noShowCount',
      key: 'noShowCount',
      width: 100,
      align: 'center' as const,
      render: (n: number) => {
        if (!n || n === 0) return <Text type="secondary">—</Text>;
        if (n >= 3) return <Tag color="red">{n} 次 ⚠️</Tag>;
        return <Tag color="orange">{n} 次</Tag>;
      },
    },
    {
      title: '加入者',
      dataIndex: 'blacklistedBy',
      key: 'blacklistedBy',
      width: 100,
    },
    {
      title: '操作',
      key: 'actions',
      width: 120,
      render: (_: any, row: BlacklistRow) => (
        <Button size="small" icon={<RollbackOutlined />} onClick={() => handleUnblacklist(row)}>
          解除黑名單
        </Button>
      ),
    },
  ];

  const repeatOffenders = rows.filter((r) => (r.noShowCount || 0) >= 3).length;

  return (
    <div style={{ padding: 24 }}>
      <Space direction="vertical" size="large" style={{ width: '100%' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <Title level={3} style={{ margin: 0 }}>
            <StopOutlined style={{ color: '#F44336', marginRight: 8 }} />
            客戶黑名單
          </Title>
          <Button icon={<ReloadOutlined />} onClick={load} loading={loading}>
            重新載入
          </Button>
        </div>

        <Row gutter={16}>
          <Col span={12}>
            <Card>
              <Statistic
                title="目前黑名單客戶"
                value={rows.length}
                suffix="位"
                valueStyle={{ color: '#F44336' }}
              />
            </Card>
          </Col>
          <Col span={12}>
            <Card>
              <Statistic
                title="累計未到 ≥ 3 次"
                value={repeatOffenders}
                suffix="位"
                valueStyle={{ color: repeatOffenders > 0 ? '#FF9800' : '#9E9E9E' }}
              />
            </Card>
          </Col>
        </Row>

        <Card>
          <div style={{ marginBottom: 12, padding: 12, background: '#FFF3E0', borderRadius: 8 }}>
            <Text type="secondary" style={{ fontSize: 13 }}>
              💡 客戶被加入黑名單後，下次叫車會直接被系統拒絕並提示聯繫客服。
              要將某乘客加入黑名單，請從「乘客管理」頁面操作。
            </Text>
          </div>

          {rows.length === 0 && !loading ? (
            <Empty description="目前沒有黑名單客戶" />
          ) : (
            <Table
              columns={columns}
              dataSource={rows}
              rowKey="passengerId"
              loading={loading}
              pagination={{ pageSize: 20 }}
            />
          )}
        </Card>
      </Space>
    </div>
  );
};

export default Blacklist;
