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
  Spin,
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
import { useDispatch, useSelector } from 'react-redux';
import { type RootState, type AppDispatch } from '../store';
import {
  fetchAnalyticsData,
  fetchRevenueTrend,
  fetchOrderTrend,
  fetchDriverActivity,
  fetchRegions,
  fetchPaymentMethods,
  fetchRatings,
  fetchTopDrivers,
} from '../store/slices/statisticsSlice';

const { Title, Text } = Typography;
const { RangePicker } = DatePicker;
const { Option } = Select;

const Analytics: React.FC = () => {
  const dispatch = useDispatch<AppDispatch>();
  const [dateRange, setDateRange] = useState<string>('week');
  const [customDateRange, setCustomDateRange] = useState<[dayjs.Dayjs | null, dayjs.Dayjs | null] | null>(null);

  const {
    analyticsData,
    revenueTrend,
    orderTrend,
    driverActivity,
    regions,
    paymentMethods,
    paymentTotal,
    ratings,
    topDrivers,
    analyticsLoading,
  } = useSelector((state: RootState) => state.statistics);

  // 根據選擇的時間範圍取得天數
  const getDays = () => {
    switch (dateRange) {
      case 'today': return 1;
      case 'week': return 7;
      case 'month': return 30;
      case 'year': return 365;
      default: return 7;
    }
  };

  // 載入資料
  useEffect(() => {
    const days = getDays();
    dispatch(fetchAnalyticsData(days));
    dispatch(fetchRevenueTrend(days));
    dispatch(fetchOrderTrend(days));
    dispatch(fetchDriverActivity());
    dispatch(fetchRegions());
    dispatch(fetchPaymentMethods());
    dispatch(fetchRatings());
    dispatch(fetchTopDrivers(5));
  }, [dispatch, dateRange]);

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
        <Tag color={rating >= 4.8 ? 'success' : rating >= 4.5 ? 'warning' : 'default'}>
          {rating ? rating.toFixed(1) : '-'}
        </Tag>
      ),
    },
    {
      title: '接單率',
      dataIndex: 'acceptRate',
      key: 'acceptRate',
      sorter: (a: any, b: any) => a.acceptRate - b.acceptRate,
      render: (rate: number) => `${rate ? rate.toFixed(0) : 0}%`,
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
      render: (_: any, record: any) =>
        record.orders > 0 ? `$${Math.round(record.revenue / record.orders)}` : '-',
    },
  ];

  // 圖表配置
  const revenueLineConfig = {
    data: revenueTrend || [],
    xField: 'date',
    yField: 'value',
    seriesField: 'type',
    smooth: true,
    color: ['#1890ff'],
    point: {
      size: 5,
      shape: 'circle',
    },
  };

  const orderAreaConfig = {
    data: orderTrend || [],
    xField: 'date',
    yField: 'value',
    smooth: true,
    color: '#52c41a',
    areaStyle: {
      fillOpacity: 0.3,
    },
  };

  const driverActivityConfig = {
    data: driverActivity || [],
    isGroup: true,
    xField: 'time',
    yField: 'active',
    seriesField: 'type',
    dodgePadding: 2,
  };

  const paymentPieConfig = {
    appendPadding: 10,
    data: paymentMethods || [],
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
        content: paymentTotal.toLocaleString(),
      },
    },
  };

  const ratingColumnConfig = {
    data: ratings || [],
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

  const summary = analyticsData?.summary;

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

      <Spin spinning={analyticsLoading}>
        {/* 關鍵指標 */}
        <Row gutter={[16, 16]} style={{ marginBottom: 24 }}>
          <Col xs={24} sm={12} lg={6}>
            <Card>
              <Statistic
                title="總營收"
                value={summary?.totalRevenue || 0}
                prefix={<DollarOutlined />}
                suffix="元"
                valueStyle={{ color: '#3f8600' }}
              />
              <div style={{ marginTop: 8 }}>
                {summary?.revenueChange !== undefined && (
                  <>
                    <Text type={summary.revenueChange >= 0 ? 'success' : 'danger'}>
                      {summary.revenueChange >= 0 ? <ArrowUpOutlined /> : <ArrowDownOutlined />}
                      {' '}{Math.abs(summary.revenueChange)}%
                    </Text>
                    <Text type="secondary" style={{ marginLeft: 8 }}>較上期</Text>
                  </>
                )}
              </div>
            </Card>
          </Col>
          <Col xs={24} sm={12} lg={6}>
            <Card>
              <Statistic
                title="總訂單數"
                value={summary?.totalOrders || 0}
                prefix={<ShoppingCartOutlined />}
                valueStyle={{ color: '#1890ff' }}
              />
              <div style={{ marginTop: 8 }}>
                {summary?.ordersChange !== undefined && (
                  <>
                    <Text type={summary.ordersChange >= 0 ? 'success' : 'danger'}>
                      {summary.ordersChange >= 0 ? <ArrowUpOutlined /> : <ArrowDownOutlined />}
                      {' '}{Math.abs(summary.ordersChange)}%
                    </Text>
                    <Text type="secondary" style={{ marginLeft: 8 }}>較上期</Text>
                  </>
                )}
              </div>
            </Card>
          </Col>
          <Col xs={24} sm={12} lg={6}>
            <Card>
              <Statistic
                title="活躍司機"
                value={summary?.activeDrivers || 0}
                prefix={<CarOutlined />}
                valueStyle={{ color: '#faad14' }}
              />
              <div style={{ marginTop: 8 }}>
                {summary?.driversChange !== undefined && (
                  <>
                    <Text type={summary.driversChange >= 0 ? 'success' : 'danger'}>
                      {summary.driversChange >= 0 ? <ArrowUpOutlined /> : <ArrowDownOutlined />}
                      {' '}{Math.abs(summary.driversChange)}%
                    </Text>
                    <Text type="secondary" style={{ marginLeft: 8 }}>較上期</Text>
                  </>
                )}
              </div>
            </Card>
          </Col>
          <Col xs={24} sm={12} lg={6}>
            <Card>
              <Statistic
                title="活躍乘客"
                value={summary?.activePassengers || 0}
                prefix={<UserOutlined />}
                valueStyle={{ color: '#722ed1' }}
              />
              <div style={{ marginTop: 8 }}>
                {summary?.passengersChange !== undefined && (
                  <>
                    <Text type={summary.passengersChange >= 0 ? 'success' : 'danger'}>
                      {summary.passengersChange >= 0 ? <ArrowUpOutlined /> : <ArrowDownOutlined />}
                      {' '}{Math.abs(summary.passengersChange)}%
                    </Text>
                    <Text type="secondary" style={{ marginLeft: 8 }}>較上期</Text>
                  </>
                )}
              </div>
            </Card>
          </Col>
        </Row>

        {/* 趨勢圖表 */}
        <Row gutter={[16, 16]} style={{ marginBottom: 24 }}>
          <Col xs={24} lg={12}>
            <Card title="營收趨勢" bordered={false}>
              {revenueTrend.length > 0 ? (
                <Line {...revenueLineConfig} height={300} />
              ) : (
                <div style={{ height: 300, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  <Text type="secondary">暫無資料</Text>
                </div>
              )}
            </Card>
          </Col>
          <Col xs={24} lg={12}>
            <Card title="訂單數量趨勢" bordered={false}>
              {orderTrend.length > 0 ? (
                <Area {...orderAreaConfig} height={300} />
              ) : (
                <div style={{ height: 300, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  <Text type="secondary">暫無資料</Text>
                </div>
              )}
            </Card>
          </Col>
        </Row>

        {/* 司機活躍度與支付方式 */}
        <Row gutter={[16, 16]} style={{ marginBottom: 24 }}>
          <Col xs={24} lg={16}>
            <Card title="司機活躍度分析（24小時）" bordered={false}>
              {driverActivity.length > 0 ? (
                <Column {...driverActivityConfig} height={300} />
              ) : (
                <div style={{ height: 300, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  <Text type="secondary">暫無資料</Text>
                </div>
              )}
            </Card>
          </Col>
          <Col xs={24} lg={8}>
            <Card title="支付方式分布" bordered={false}>
              {paymentMethods.length > 0 ? (
                <Pie {...paymentPieConfig} height={300} />
              ) : (
                <div style={{ height: 300, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  <Text type="secondary">暫無資料</Text>
                </div>
              )}
            </Card>
          </Col>
        </Row>

        {/* 評分分布 */}
        <Row gutter={[16, 16]} style={{ marginBottom: 24 }}>
          <Col xs={24}>
            <Card title="訂單評分分布" bordered={false}>
              {ratings.length > 0 ? (
                <Column {...ratingColumnConfig} height={250} />
              ) : (
                <div style={{ height: 250, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  <Text type="secondary">暫無評分資料</Text>
                </div>
              )}
            </Card>
          </Col>
        </Row>

        {/* 排行榜和區域數據 */}
        <Row gutter={[16, 16]}>
          <Col xs={24} lg={12}>
            <Card title="頂級司機排行榜" bordered={false}>
              <Table
                columns={topDriverColumns}
                dataSource={topDrivers}
                pagination={false}
                size="middle"
                locale={{ emptyText: '暫無資料' }}
              />
            </Card>
          </Col>
          <Col xs={24} lg={12}>
            <Card title="熱門區域分析" bordered={false}>
              <Table
                columns={regionColumns}
                dataSource={regions.map((r: any, i: number) => ({ ...r, key: i }))}
                pagination={false}
                size="middle"
                locale={{ emptyText: '暫無資料' }}
              />
            </Card>
          </Col>
        </Row>
      </Spin>
    </div>
  );
};

export default Analytics;
