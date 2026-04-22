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
  Spin,
} from 'antd';
import {
  CarOutlined,
  UserOutlined,
  ShoppingCartOutlined,
  RiseOutlined,
  FallOutlined,
  CheckCircleOutlined,
  CloseCircleOutlined,
  ClockCircleOutlined,
} from '@ant-design/icons';
import { Line, Column, Pie } from '@ant-design/plots';
import { useDispatch, useSelector } from 'react-redux';
import { Link } from 'react-router-dom';
import {
  fetchDashboardStats,
  fetchRealtimeStats,
  fetchRevenueTrend,
  fetchOrderStatus,
  fetchPeakHours,
  fetchRecentOrders,
} from '../store/slices/statisticsSlice';
import { type RootState, type AppDispatch } from '../store';

const { Title, Text } = Typography;

const Dashboard: React.FC = () => {
  const dispatch = useDispatch<AppDispatch>();
  const {
    dashboardStats,
    realtimeStats,
    revenueTrend,
    orderStatus,
    peakHours,
    recentOrders,
    loading,
  } = useSelector((state: RootState) => state.statistics);

  useEffect(() => {
    // 載入儀表板統計資料
    dispatch(fetchDashboardStats());
    dispatch(fetchRealtimeStats());
    dispatch(fetchRevenueTrend(7));
    dispatch(fetchOrderStatus());
    dispatch(fetchPeakHours());
    dispatch(fetchRecentOrders(5));

    // 每30秒更新一次即時資料
    const interval = setInterval(() => {
      dispatch(fetchRealtimeStats());
    }, 30000);

    return () => clearInterval(interval);
  }, [dispatch]);

  const orderColumns = [
    {
      title: '訂單編號',
      dataIndex: 'orderId',
      key: 'orderId',
      render: (text: string) => <a>{text?.slice(0, 12) || '-'}</a>,
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
          done: { color: 'success', text: '已完成', icon: <CheckCircleOutlined /> },
          completed: { color: 'success', text: '已完成', icon: <CheckCircleOutlined /> },
          on_trip: { color: 'processing', text: '進行中', icon: <ClockCircleOutlined /> },
          arrived: { color: 'processing', text: '已到達', icon: <ClockCircleOutlined /> },
          accepted: { color: 'processing', text: '已接單', icon: <ClockCircleOutlined /> },
          waiting: { color: 'warning', text: '等待中', icon: <ClockCircleOutlined /> },
          offered: { color: 'warning', text: '派單中', icon: <ClockCircleOutlined /> },
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
      render: (fare: number) => (fare > 0 ? `NT$${fare}` : '-'),
    },
    {
      title: '時間',
      dataIndex: 'time',
      key: 'time',
    },
  ];

  // 線圖配置（@ant-design/plots v2 相容）
  const lineConfig = {
    data: revenueTrend || [],
    xField: 'date',
    yField: 'value',
    colorField: 'type',
    smooth: true,
  };

  // 圓餅圖配置（@ant-design/plots v2 相容，移除 v1 專屬 label/interactions/statistic）
  const totalOrders = orderStatus.reduce((sum: number, item: any) => sum + item.value, 0);
  const pieConfig = {
    data: orderStatus || [],
    angleField: 'value',
    colorField: 'type',
    radius: 1,
    innerRadius: 0.6,
    label: {
      text: 'value',
      position: 'inside',
    },
    annotations: [
      {
        type: 'text',
        style: {
          text: `訂單總數\n${totalOrders}`,
          x: '50%',
          y: '50%',
          textAlign: 'center',
          fontSize: 16,
          fontWeight: 'bold',
        },
      },
    ],
  };

  // 柱狀圖配置（@ant-design/plots v2 相容）
  const columnConfig = {
    data: peakHours || [],
    xField: 'hour',
    yField: 'orders',
    label: {
      text: 'orders',
      position: 'inside',
      style: {
        fill: '#FFFFFF',
        fillOpacity: 0.7,
      },
    },
    axis: {
      x: { title: '時段' },
      y: { title: '訂單數' },
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

  // 計算今日完成率
  const completionRate = realtimeStats
    ? Math.round(
        (realtimeStats.todayCompleted /
          (realtimeStats.todayCompleted + realtimeStats.todayCancelled + realtimeStats.activeOrders || 1)) *
          100
      )
    : 0;

  return (
    <div>
      <Title level={2} style={{ marginBottom: 24 }}>
        營運儀表板
      </Title>

      <Spin spinning={loading}>
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
                <Badge status="success" text={`在線: ${realtimeStats?.onlineDrivers || dashboardStats?.activeDrivers || 0}`} />
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
                <Text type="secondary">進行中訂單: {realtimeStats?.activeOrders || 0}</Text>
              </div>
            </Card>
          </Col>
          <Col xs={24} sm={12} lg={6}>
            <Card>
              <Statistic
                title="今日訂單"
                value={realtimeStats?.todayCompleted || 0}
                prefix={<ShoppingCartOutlined />}
                suffix={`/ ${(realtimeStats?.todayCompleted || 0) + (realtimeStats?.todayCancelled || 0)}`}
                valueStyle={{ color: '#faad14' }}
              />
              <div style={{ marginTop: 8 }}>
                <Space>
                  {realtimeStats?.todayCancelled > 0 ? (
                    <Text type="danger">
                      <FallOutlined /> 取消: {realtimeStats.todayCancelled}
                    </Text>
                  ) : (
                    <Text type="success">
                      <RiseOutlined /> 無取消
                    </Text>
                  )}
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
                  percent={completionRate}
                  size="small"
                  format={() => `完成率 ${completionRate}%`}
                  strokeColor="#f5222d"
                />
              </div>
            </Card>
          </Col>
        </Row>

        {/* 圖表區域 */}
        <Row gutter={[16, 16]} style={{ marginBottom: 24 }}>
          <Col xs={24} lg={16}>
            <Card title="營收趨勢（近7天）" bordered={false}>
              {revenueTrend.length > 0 ? (
                <Line {...lineConfig} height={300} />
              ) : (
                <div style={{ height: 300, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  <Text type="secondary">暫無資料</Text>
                </div>
              )}
            </Card>
          </Col>
          <Col xs={24} lg={8}>
            <Card title="訂單狀態分布（近30天）" bordered={false}>
              {orderStatus.length > 0 ? (
                <Pie {...pieConfig} height={300} />
              ) : (
                <div style={{ height: 300, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  <Text type="secondary">暫無資料</Text>
                </div>
              )}
            </Card>
          </Col>
        </Row>

        <Row gutter={[16, 16]} style={{ marginBottom: 24 }}>
          <Col xs={24} lg={24}>
            <Card title="熱門時段分析（近30天）" bordered={false}>
              {peakHours.length > 0 ? (
                <Column {...columnConfig} height={250} />
              ) : (
                <div style={{ height: 250, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  <Text type="secondary">暫無資料</Text>
                </div>
              )}
            </Card>
          </Col>
        </Row>

        {/* 最近訂單 */}
        <Card
          title="最近訂單"
          bordered={false}
          extra={<Link to="/orders">查看全部</Link>}
        >
          <Table
            columns={orderColumns}
            dataSource={recentOrders}
            pagination={false}
            size="middle"
            locale={{ emptyText: '暫無訂單' }}
          />
        </Card>
      </Spin>
    </div>
  );
};

export default Dashboard;
