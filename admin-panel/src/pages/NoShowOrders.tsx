import React, { useEffect, useState } from 'react';
import {
  Card,
  Table,
  Tag,
  Space,
  Typography,
  Select,
  Statistic,
  Row,
  Col,
  Button,
  Tooltip,
  Empty,
} from 'antd';
import {
  ExclamationCircleOutlined,
  ReloadOutlined,
  CarOutlined,
  UserOutlined,
  DollarOutlined,
} from '@ant-design/icons';
import dayjs from 'dayjs';
import { noShowAPI } from '../services/api';

const { Title, Text } = Typography;
const { Option } = Select;

interface NoShowRow {
  orderId: string;
  passengerId: string;
  passengerName: string;
  passengerPhone: string;
  passengerNoShowTotal: number;
  driverId: string;
  driverName: string;
  driverPlate: string;
  pickupAddress: string;
  source: string;
  cancelledAt: string;
  cancelReason: string;
  penaltyFare: number;
}

const NoShowOrders: React.FC = () => {
  const [rows, setRows] = useState<NoShowRow[]>([]);
  const [total, setTotal] = useState(0);
  const [days, setDays] = useState(30);
  const [loading, setLoading] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const data = await noShowAPI.getList(days, 200, 0);
      setRows(data.orders);
      setTotal(data.total);
    } catch (err) {
      console.error('[NoShow] load failed:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, [days]);

  // 統計：總罰金、重複客人數
  const totalPenalty = rows.reduce((sum, r) => sum + (r.penaltyFare || 0), 0);
  const repeatOffenders = rows.filter(r => r.passengerNoShowTotal >= 3).length;

  const columns = [
    {
      title: '取消時間',
      dataIndex: 'cancelledAt',
      key: 'cancelledAt',
      width: 160,
      render: (t: string) => (
        <div>
          <div>{dayjs(t).format('MM-DD HH:mm')}</div>
          <Text type="secondary" style={{ fontSize: 12 }}>
            {dayjs(t).fromNow()}
          </Text>
        </div>
      ),
      sorter: (a: NoShowRow, b: NoShowRow) => dayjs(a.cancelledAt).valueOf() - dayjs(b.cancelledAt).valueOf(),
      defaultSortOrder: 'descend' as const,
    },
    {
      title: '訂單',
      dataIndex: 'orderId',
      key: 'orderId',
      width: 140,
      render: (id: string, row: NoShowRow) => (
        <div>
          <Text code style={{ fontSize: 12 }}>{id.substring(0, 13)}</Text>
          <br />
          <Tag color={row.source === 'LINE' ? 'green' : row.source === 'PHONE' ? 'orange' : 'blue'}>
            {row.source}
          </Tag>
        </div>
      ),
    },
    {
      title: '乘客',
      key: 'passenger',
      render: (_: any, row: NoShowRow) => (
        <div>
          <div>
            <UserOutlined /> {row.passengerName || '—'}
          </div>
          {row.passengerPhone && !row.passengerPhone.startsWith('LINE_') && !row.passengerPhone.startsWith('PHONE_') && (
            <Text type="secondary" style={{ fontSize: 12 }}>{row.passengerPhone}</Text>
          )}
        </div>
      ),
    },
    {
      title: '累計未到',
      dataIndex: 'passengerNoShowTotal',
      key: 'passengerNoShowTotal',
      width: 100,
      align: 'center' as const,
      render: (n: number) => {
        if (n >= 3) return <Tag color="red" style={{ fontSize: 14 }}>{n} 次 ⚠️</Tag>;
        if (n >= 2) return <Tag color="orange">{n} 次</Tag>;
        return <Tag>{n || 1} 次</Tag>;
      },
      sorter: (a: NoShowRow, b: NoShowRow) => (a.passengerNoShowTotal || 0) - (b.passengerNoShowTotal || 0),
    },
    {
      title: '司機 / 車牌',
      key: 'driver',
      render: (_: any, row: NoShowRow) => (
        <div>
          <div><CarOutlined /> {row.driverName || '—'}</div>
          <Text type="secondary" style={{ fontSize: 12 }}>{row.driverPlate}</Text>
        </div>
      ),
    },
    {
      title: '上車點',
      dataIndex: 'pickupAddress',
      key: 'pickupAddress',
      ellipsis: true,
      render: (addr: string) => (
        <Tooltip title={addr}>{addr}</Tooltip>
      ),
    },
    {
      title: '取消原因（含司機等候時長）',
      dataIndex: 'cancelReason',
      key: 'cancelReason',
      width: 220,
      render: (r: string) => <Text>{r}</Text>,
    },
    {
      title: '罰金',
      dataIndex: 'penaltyFare',
      key: 'penaltyFare',
      width: 90,
      align: 'right' as const,
      render: (n: number) => n > 0
        ? <Text strong style={{ color: '#F44336' }}>NT$ {n}</Text>
        : <Text type="secondary">—</Text>,
      sorter: (a: NoShowRow, b: NoShowRow) => (a.penaltyFare || 0) - (b.penaltyFare || 0),
    },
  ];

  return (
    <div style={{ padding: 24 }}>
      <Space direction="vertical" size="large" style={{ width: '100%' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <Title level={3} style={{ margin: 0 }}>
            <ExclamationCircleOutlined style={{ color: '#FF9800', marginRight: 8 }} />
            客人未到（No-Show）訂單
          </Title>
          <Space>
            <Select value={days} onChange={setDays} style={{ width: 140 }}>
              <Option value={7}>近 7 天</Option>
              <Option value={30}>近 30 天</Option>
              <Option value={90}>近 90 天</Option>
            </Select>
            <Button icon={<ReloadOutlined />} onClick={load} loading={loading}>
              重新載入
            </Button>
          </Space>
        </div>

        <Row gutter={16}>
          <Col span={8}>
            <Card>
              <Statistic
                title={`近 ${days} 天 no-show 訂單數`}
                value={total}
                suffix="單"
                valueStyle={{ color: '#FF9800' }}
              />
            </Card>
          </Col>
          <Col span={8}>
            <Card>
              <Statistic
                title="總罰金（應收）"
                value={totalPenalty}
                prefix="NT$"
                valueStyle={{ color: '#F44336' }}
              />
            </Card>
          </Col>
          <Col span={8}>
            <Card>
              <Statistic
                title="累積 3 次以上客人"
                value={repeatOffenders}
                suffix="人"
                valueStyle={{ color: repeatOffenders > 0 ? '#F44336' : '#9E9E9E' }}
              />
            </Card>
          </Col>
        </Row>

        <Card>
          {rows.length === 0 && !loading ? (
            <Empty description={`近 ${days} 天沒有客人未到的訂單`} />
          ) : (
            <Table
              columns={columns}
              dataSource={rows}
              rowKey="orderId"
              loading={loading}
              pagination={{ pageSize: 20, showSizeChanger: true }}
              size="middle"
            />
          )}
        </Card>
      </Space>
    </div>
  );
};

export default NoShowOrders;
