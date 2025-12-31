import React, { useState, useEffect } from 'react';
import {
  Card,
  Row,
  Col,
  Typography,
  Select,
  DatePicker,
  Space,
  Statistic,
  Table,
  Tag,
} from 'antd';
import {
  ArrowUpOutlined,
  ArrowDownOutlined,
  DollarOutlined,
  CarOutlined,
  UserOutlined,
  ShoppingCartOutlined,
} from '@ant-design/icons';
import { Line, Column, Pie, Area } from '@ant-design/plots';
import dayjs from 'dayjs';

const { Title, Text } = Typography;
const { RangePicker } = DatePicker;
const { Option } = Select;

const Analytics: React.FC = () => {
  const [dateRange, setDateRange] = useState<string>('week');
  const [customDateRange, setCustomDateRange] = useState<[dayjs.Dayjs | null, dayjs.Dayjs | null] | null>(null);

  // 營收趨勢數據
  const revenueData = [
    { date: '2025-11-05', value: 45000, type: '營收' },
    { date: '2025-11-06', value: 52000, type: '營收' },
    { date: '2025-11-07', value: 48000, type: '營收' },
    { date: '2025-11-08', value: 61000, type: '營收' },
    { date: '2025-11-09', value: 58000, type: '營收' },
    { date: '2025-11-10', value: 55000, type: '營收' },
    { date: '2025-11-11', value: 62000, type: '營收' },
    { date: '2025-11-12', value: 68000, type: '營收' },
  ];

  // 訂單數量趨勢
  const orderTrendData = [
    { date: '2025-11-05', value: 158, type: '訂單數' },
    { date: '2025-11-06', value: 182, type: '訂單數' },
    { date: '2025-11-07', value: 165, type: '訂單數' },
    { date: '2025-11-08', value: 201, type: '訂單數' },
    { date: '2025-11-09', value: 195, type: '訂單數' },
    { date: '2025-11-10', value: 188, type: '訂單數' },
    { date: '2025-11-11', value: 172, type: '訂單數' },
    { date: '2025-11-12', value: 215, type: '訂單數' },
  ];

  // 司機活躍度數據
  const driverActivityData = [
    { time: '00:00', active: 12, busy: 8 },
    { time: '03:00', active: 5, busy: 3 },
    { time: '06:00', active: 25, busy: 18 },
    { time: '09:00', active: 42, busy: 35 },
    { time: '12:00', active: 48, busy: 40 },
    { time: '15:00', active: 38, busy: 28 },
    { time: '18:00', active: 55, busy: 48 },
    { time: '21:00', active: 35, busy: 25 },
  ];

  // 區域熱點數據
  const regionData = [
    { region: '花蓮火車站', orders: 485, revenue: 145500 },
    { region: '東大門夜市', orders: 368, revenue: 110400 },
    { region: '七星潭', orders: 292, revenue: 175200 },
    { region: '太魯閣', orders: 185, revenue: 185000 },
    { region: '花蓮機場', orders: 156, revenue: 93600 },
    { region: '市區商圈', orders: 234, revenue: 70200 },
  ];

  // 支付方式分布
  const paymentMethodData = [
    { type: '現金', value: 4280, percentage: 45 },
    { type: '信用卡', value: 3350, percentage: 35 },
    { type: '電子錢包', value: 1900, percentage: 20 },
  ];

  // 評分分布
  const ratingData = [
    { rating: '5星', count: 6580 },
    { rating: '4星', count: 2150 },
    { rating: '3星', count: 680 },
    { rating: '2星', count: 280 },
    { rating: '1星', count: 110 },
  ];

  // 頂級司機排行
  const topDriversData = [
    {
      key: '1',
      rank: 1,
      name: '李師傅',
      trips: 358,
      revenue: 107400,
      rating: 4.9,
      acceptRate: 98,
    },
    {
      key: '2',
      rank: 2,
      name: '張師傅',
      trips: 342,
      revenue: 102600,
      rating: 4.8,
      acceptRate: 96,
    },
    {
      key: '3',
      rank: 3,
      name: '王師傅',
      trips: 328,
      revenue: 98400,
      rating: 4.9,
      acceptRate: 97,
    },
    {
      key: '4',
      rank: 4,
      name: '陳師傅',
      trips: 315,
      revenue: 94500,
      rating: 4.7,
      acceptRate: 95,
    },
    {
      key: '5',
      rank: 5,
      name: '林師傅',
      trips: 298,
      revenue: 89400,
      rating: 4.8,
      acceptRate: 94,
    },
  ];

  const topDriverColumns = [
    {
      title: '排名',
      dataIndex: 'rank',
      key: 'rank',
      width: 60,
      render: (rank: number) => (
        <Tag color={rank === 1 ? 'gold' : rank === 2 ? 'silver' : rank === 3 ? '#cd7f32' : 'default'}>
          #{rank}
        </Tag>
      ),
    },
    {
      title: '司機',
      dataIndex: 'name',
      key: 'name',
      render: (name: string) => <strong>{name}</strong>,
    },
    {
      title: '總行程',
      dataIndex: 'trips',
      key: 'trips',
      sorter: (a: any, b: any) => a.trips - b.trips,
    },
    {
      title: '營收',
      dataIndex: 'revenue',
      key: 'revenue',
      sorter: (a: any, b: any) => a.revenue - b.revenue,
      render: (revenue: number) => `$${revenue.toLocaleString()}`,
    },
    {
      title: '評分',
      dataIndex: 'rating',
      key: 'rating',
      sorter: (a: any, b: any) => a.rating - b.rating,
      render: (rating: number) => (
        <Tag color={rating >= 4.8 ? 'success' : 'warning'}>{rating.toFixed(1)}</Tag>
      ),
    },
    {
      title: '接單率',
      dataIndex: 'acceptRate',
      key: 'acceptRate',
      sorter: (a: any, b: any) => a.acceptRate - b.acceptRate,
      render: (rate: number) => `${rate}%`,
    },
  ];

  const regionColumns = [
    {
      title: '區域',
      dataIndex: 'region',
      key: 'region',
      render: (region: string) => <strong>{region}</strong>,
    },
    {
      title: '訂單數',
      dataIndex: 'orders',
      key: 'orders',
      sorter: (a: any, b: any) => a.orders - b.orders,
    },
    {
      title: '總營收',
      dataIndex: 'revenue',
      key: 'revenue',
      sorter: (a: any, b: any) => a.revenue - b.revenue,
      render: (revenue: number) => `$${revenue.toLocaleString()}`,
    },
    {
      title: '平均車資',
      key: 'avgFare',
      render: (_: any, record: any) => `$${Math.round(record.revenue / record.orders)}`,
    },
  ];

  // 圖表配置
  const revenueLineConfig = {
    data: revenueData,
    xField: 'date',
    yField: 'value',
    seriesField: 'type',
    smooth: true,
    color: ['#1890ff'],
    point: {
      size: 5,
      shape: 'circle',
    },
    label: {
      style: {
        fill: '#aaa',
      },
    },
  };

  const orderAreaConfig = {
    data: orderTrendData,
    xField: 'date',
    yField: 'value',
    smooth: true,
    color: '#52c41a',
    areaStyle: {
      fillOpacity: 0.3,
    },
  };

  const driverActivityConfig = {
    data: driverActivityData,
    isGroup: true,
    xField: 'time',
    yField: 'active',
    seriesField: 'type',
    dodgePadding: 2,
    label: {
      position: 'top' as const,
      layout: [
        { type: 'interval-adjust-position' },
        { type: 'interval-hide-overlap' },
        { type: 'adjust-color' },
      ],
    },
  };

  const paymentPieConfig = {
    appendPadding: 10,
    data: paymentMethodData,
    angleField: 'value',
    colorField: 'type',
    radius: 0.9,
    innerRadius: 0.6,
    label: {
      type: 'inner',
      offset: '-30%',
      content: '{value}',
      style: {
        fontSize: 14,
        textAlign: 'center',
      },
    },
    legend: {
      position: 'bottom' as const,
    },
    statistic: {
      title: {
        content: '總訂單',
      },
      content: {
        content: '9,530',
      },
    },
  };

  const ratingColumnConfig = {
    data: ratingData,
    xField: 'rating',
    yField: 'count',
    color: '#faad14',
    label: {
      position: 'top' as const,
      style: {
        fill: '#000000',
        opacity: 0.6,
      },
    },
    xAxis: {
      label: {
        autoHide: false,
        autoRotate: false,
      },
    },
  };

  return (
    <div>
      <Row gutter={[16, 16]} style={{ marginBottom: 24 }}>
        <Col span={24}>
          <Space>
            <Title level={2} style={{ margin: 0 }}>數據分析</Title>
            <Select
              defaultValue="week"
              style={{ width: 120 }}
              onChange={(value) => setDateRange(value)}
            >
              <Option value="today">今天</Option>
              <Option value="week">本週</Option>
              <Option value="month">本月</Option>
              <Option value="year">今年</Option>
              <Option value="custom">自訂</Option>
            </Select>
            {dateRange === 'custom' && (
              <RangePicker
                onChange={(dates) => setCustomDateRange(dates as [dayjs.Dayjs | null, dayjs.Dayjs | null] | null)}
              />
            )}
          </Space>
        </Col>
      </Row>

      {/* 關鍵指標 */}
      <Row gutter={[16, 16]} style={{ marginBottom: 24 }}>
        <Col xs={24} sm={12} lg={6}>
          <Card>
            <Statistic
              title="總營收"
              value={449000}
              prefix={<DollarOutlined />}
              suffix="元"
              valueStyle={{ color: '#3f8600' }}
            />
            <div style={{ marginTop: 8 }}>
              <Text type="success">
                <ArrowUpOutlined /> 12.5%
              </Text>
              <Text type="secondary" style={{ marginLeft: 8 }}>較上週</Text>
            </div>
          </Card>
        </Col>
        <Col xs={24} sm={12} lg={6}>
          <Card>
            <Statistic
              title="總訂單數"
              value={1476}
              prefix={<ShoppingCartOutlined />}
              valueStyle={{ color: '#1890ff' }}
            />
            <div style={{ marginTop: 8 }}>
              <Text type="success">
                <ArrowUpOutlined /> 8.3%
              </Text>
              <Text type="secondary" style={{ marginLeft: 8 }}>較上週</Text>
            </div>
          </Card>
        </Col>
        <Col xs={24} sm={12} lg={6}>
          <Card>
            <Statistic
              title="活躍司機"
              value={156}
              prefix={<CarOutlined />}
              valueStyle={{ color: '#faad14' }}
            />
            <div style={{ marginTop: 8 }}>
              <Text type="danger">
                <ArrowDownOutlined /> 2.1%
              </Text>
              <Text type="secondary" style={{ marginLeft: 8 }}>較上週</Text>
            </div>
          </Card>
        </Col>
        <Col xs={24} sm={12} lg={6}>
          <Card>
            <Statistic
              title="活躍乘客"
              value={892}
              prefix={<UserOutlined />}
              valueStyle={{ color: '#722ed1' }}
            />
            <div style={{ marginTop: 8 }}>
              <Text type="success">
                <ArrowUpOutlined /> 15.2%
              </Text>
              <Text type="secondary" style={{ marginLeft: 8 }}>較上週</Text>
            </div>
          </Card>
        </Col>
      </Row>

      {/* 趨勢圖表 */}
      <Row gutter={[16, 16]} style={{ marginBottom: 24 }}>
        <Col xs={24} lg={12}>
          <Card title="營收趨勢" bordered={false}>
            <Line {...revenueLineConfig} height={300} />
          </Card>
        </Col>
        <Col xs={24} lg={12}>
          <Card title="訂單數量趨勢" bordered={false}>
            <Area {...orderAreaConfig} height={300} />
          </Card>
        </Col>
      </Row>

      {/* 司機活躍度與支付方式 */}
      <Row gutter={[16, 16]} style={{ marginBottom: 24 }}>
        <Col xs={24} lg={16}>
          <Card title="司機活躍度分析（24小時）" bordered={false}>
            <Column {...driverActivityConfig} height={300} />
          </Card>
        </Col>
        <Col xs={24} lg={8}>
          <Card title="支付方式分布" bordered={false}>
            <Pie {...paymentPieConfig} height={300} />
          </Card>
        </Col>
      </Row>

      {/* 評分分布 */}
      <Row gutter={[16, 16]} style={{ marginBottom: 24 }}>
        <Col xs={24}>
          <Card title="訂單評分分布" bordered={false}>
            <Column {...ratingColumnConfig} height={250} />
          </Card>
        </Col>
      </Row>

      {/* 排行榜和區域數據 */}
      <Row gutter={[16, 16]}>
        <Col xs={24} lg={12}>
          <Card title="頂級司機排行榜" bordered={false}>
            <Table
              columns={topDriverColumns}
              dataSource={topDriversData}
              pagination={false}
              size="middle"
            />
          </Card>
        </Col>
        <Col xs={24} lg={12}>
          <Card title="熱門區域分析" bordered={false}>
            <Table
              columns={regionColumns}
              dataSource={regionData}
              pagination={false}
              size="middle"
            />
          </Card>
        </Col>
      </Row>
    </div>
  );
};

export default Analytics;
