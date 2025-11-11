import React, { useEffect } from 'react';
import {
  Card,
  Col,
  Row,
  Statistic,
  Typography,
  Progress,
  Table,
  Tag,
  Space,
  Badge,
} from 'antd';
import {
  CarOutlined,
  UserOutlined,
  ShoppingCartOutlined,
  RiseOutlined,
  CheckCircleOutlined,
  CloseCircleOutlined,
  ClockCircleOutlined,
} from '@ant-design/icons';
import { Line, Column, Pie } from '@ant-design/plots';
import { useDispatch, useSelector } from 'react-redux';
import { fetchDashboardStats, fetchRealtimeStats } from '../store/slices/statisticsSlice';
import { type RootState, type AppDispatch } from '../store';

const { Title, Text } = Typography;

const Dashboard: React.FC = () => {
  const dispatch = useDispatch<AppDispatch>();
  const { dashboardStats } = useSelector(
    (state: RootState) => state.statistics
  );

  useEffect(() => {
    // 載入儀表板統計資料
    dispatch(fetchDashboardStats());

    // 載入即時資料
    dispatch(fetchRealtimeStats());

    // 每30秒更新一次即時資料
    const interval = setInterval(() => {
      dispatch(fetchRealtimeStats());
    }, 30000);

    return () => clearInterval(interval);
  }, [dispatch]);

  // 營收趨勢資料（模擬）
  const revenueData = [
    { date: '2024-11-05', value: 45000, type: '營收' },
    { date: '2024-11-06', value: 52000, type: '營收' },
    { date: '2024-11-07', value: 48000, type: '營收' },
    { date: '2024-11-08', value: 61000, type: '營收' },
    { date: '2024-11-09', value: 58000, type: '營收' },
    { date: '2024-11-10', value: 55000, type: '營收' },
    { date: '2024-11-11', value: 42000, type: '營收' },
  ];

  // 訂單狀態分布（模擬）
  const orderStatusData = [
    { type: '已完成', value: 320 },
    { type: '進行中', value: 45 },
    { type: '已取消', value: 28 },
    { type: '等待中', value: 15 },
  ];

  // 熱門時段資料（模擬）
  const peakHoursData = [
    { hour: '06:00', orders: 15 },
    { hour: '07:00', orders: 28 },
    { hour: '08:00', orders: 42 },
    { hour: '09:00', orders: 35 },
    { hour: '10:00', orders: 25 },
    { hour: '11:00', orders: 30 },
    { hour: '12:00', orders: 48 },
    { hour: '13:00', orders: 38 },
    { hour: '14:00', orders: 28 },
    { hour: '15:00', orders: 32 },
    { hour: '16:00', orders: 35 },
    { hour: '17:00', orders: 45 },
    { hour: '18:00', orders: 55 },
    { hour: '19:00', orders: 48 },
    { hour: '20:00', orders: 35 },
    { hour: '21:00', orders: 25 },
    { hour: '22:00', orders: 18 },
    { hour: '23:00', orders: 12 },
  ];

  // 最近訂單（模擬）
  const recentOrders = [
    {
      key: '1',
      orderId: 'ORD001234',
      passenger: '王小明',
      driver: '李師傅',
      status: 'completed',
      fare: 280,
      time: '5分鐘前',
    },
    {
      key: '2',
      orderId: 'ORD001235',
      passenger: '陳小姐',
      driver: '張師傅',
      status: 'in_progress',
      fare: 350,
      time: '10分鐘前',
    },
    {
      key: '3',
      orderId: 'ORD001236',
      passenger: '林先生',
      driver: '王師傅',
      status: 'pending',
      fare: 0,
      time: '12分鐘前',
    },
    {
      key: '4',
      orderId: 'ORD001237',
      passenger: '黃小姐',
      driver: '劉師傅',
      status: 'cancelled',
      fare: 0,
      time: '15分鐘前',
    },
    {
      key: '5',
      orderId: 'ORD001238',
      passenger: '吳先生',
      driver: '陳師傅',
      status: 'completed',
      fare: 420,
      time: '20分鐘前',
    },
  ];

  const orderColumns = [
    {
      title: '訂單編號',
      dataIndex: 'orderId',
      key: 'orderId',
      render: (text: string) => <a>{text}</a>,
    },
    {
      title: '乘客',
      dataIndex: 'passenger',
      key: 'passenger',
    },
    {
      title: '司機',
      dataIndex: 'driver',
      key: 'driver',
    },
    {
      title: '狀態',
      dataIndex: 'status',
      key: 'status',
      render: (status: string) => {
        const statusMap: { [key: string]: { color: string; text: string; icon: React.ReactNode } } = {
          completed: { color: 'success', text: '已完成', icon: <CheckCircleOutlined /> },
          in_progress: { color: 'processing', text: '進行中', icon: <ClockCircleOutlined /> },
          pending: { color: 'warning', text: '等待中', icon: <ClockCircleOutlined /> },
          cancelled: { color: 'error', text: '已取消', icon: <CloseCircleOutlined /> },
        };
        const config = statusMap[status] || { color: 'default', text: status, icon: null };
        return (
          <Tag color={config.color}>
            {config.icon} {config.text}
          </Tag>
        );
      },
    },
    {
      title: '車資',
      dataIndex: 'fare',
      key: 'fare',
      render: (fare: number) => (fare > 0 ? `$${fare}` : '-'),
    },
    {
      title: '時間',
      dataIndex: 'time',
      key: 'time',
    },
  ];

  // 線圖配置
  const lineConfig = {
    data: revenueData,
    xField: 'date',
    yField: 'value',
    seriesField: 'type',
    smooth: true,
    animation: {
      appear: {
        animation: 'path-in',
        duration: 1000,
      },
    },
  };

  // 圓餅圖配置
  const pieConfig = {
    appendPadding: 10,
    data: orderStatusData,
    angleField: 'value',
    colorField: 'type',
    radius: 1,
    innerRadius: 0.6,
    label: {
      type: 'inner',
      offset: '-50%',
      content: '{value}',
      style: {
        textAlign: 'center',
        fontSize: 14,
      },
    },
    interactions: [
      {
        type: 'element-selected',
      },
      {
        type: 'element-active',
      },
    ],
    statistic: {
      title: false,
      content: {
        style: {
          whiteSpace: 'pre-wrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
        },
        content: '訂單總數\n408',
      },
    },
  };

  // 柱狀圖配置
  const columnConfig = {
    data: peakHoursData,
    xField: 'hour',
    yField: 'orders',
    label: {
      position: 'middle',
      style: {
        fill: '#FFFFFF',
        opacity: 0.6,
      },
    },
    xAxis: {
      label: {
        autoHide: true,
        autoRotate: false,
      },
    },
    meta: {
      hour: {
        alias: '時段',
      },
      orders: {
        alias: '訂單數',
      },
    },
  };

  return (
    <div>
      <Title level={2} style={{ marginBottom: 24 }}>
        營運儀表板
      </Title>

      {/* 統計卡片 */}
      <Row gutter={[16, 16]} style={{ marginBottom: 24 }}>
        <Col xs={24} sm={12} lg={6}>
          <Card>
            <Statistic
              title="總司機數"
              value={dashboardStats?.totalDrivers || 0}
              prefix={<CarOutlined />}
              valueStyle={{ color: '#1890ff' }}
            />
            <div style={{ marginTop: 8 }}>
              <Badge status="success" text={`在線: ${dashboardStats?.activeDrivers || 0}`} />
            </div>
          </Card>
        </Col>
        <Col xs={24} sm={12} lg={6}>
          <Card>
            <Statistic
              title="總乘客數"
              value={dashboardStats?.totalPassengers || 0}
              prefix={<UserOutlined />}
              valueStyle={{ color: '#52c41a' }}
            />
            <div style={{ marginTop: 8 }}>
              <Text type="secondary">本月新增: 128</Text>
            </div>
          </Card>
        </Col>
        <Col xs={24} sm={12} lg={6}>
          <Card>
            <Statistic
              title="今日訂單"
              value={dashboardStats?.totalOrders || 0}
              prefix={<ShoppingCartOutlined />}
              valueStyle={{ color: '#faad14' }}
            />
            <div style={{ marginTop: 8 }}>
              <Space>
                <Text type="success">
                  <RiseOutlined /> 12.5%
                </Text>
                <Text type="secondary">較昨日</Text>
              </Space>
            </div>
          </Card>
        </Col>
        <Col xs={24} sm={12} lg={6}>
          <Card>
            <Statistic
              title="今日營收"
              value={dashboardStats?.todayRevenue || 0}
              prefix="$"
              valueStyle={{ color: '#f5222d' }}
            />
            <div style={{ marginTop: 8 }}>
              <Progress
                percent={75}
                size="small"
                format={() => `目標 75%`}
                strokeColor="#f5222d"
              />
            </div>
          </Card>
        </Col>
      </Row>

      {/* 圖表區域 */}
      <Row gutter={[16, 16]} style={{ marginBottom: 24 }}>
        <Col xs={24} lg={16}>
          <Card title="營收趨勢" bordered={false}>
            <Line {...lineConfig} height={300} />
          </Card>
        </Col>
        <Col xs={24} lg={8}>
          <Card title="訂單狀態分布" bordered={false}>
            <Pie {...pieConfig} height={300} />
          </Card>
        </Col>
      </Row>

      <Row gutter={[16, 16]} style={{ marginBottom: 24 }}>
        <Col xs={24} lg={24}>
          <Card title="熱門時段分析" bordered={false}>
            <Column {...columnConfig} height={250} />
          </Card>
        </Col>
      </Row>

      {/* 最近訂單 */}
      <Card
        title="最近訂單"
        bordered={false}
        extra={<a href="/orders">查看全部</a>}
      >
        <Table
          columns={orderColumns}
          dataSource={recentOrders}
          pagination={false}
          size="middle"
        />
      </Card>
    </div>
  );
};

export default Dashboard;