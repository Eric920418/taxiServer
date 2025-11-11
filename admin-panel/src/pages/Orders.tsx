import React, { useEffect, useState } from 'react';
import {
  Table,
  Card,
  Input,
  Select,
  DatePicker,
  Button,
  Space,
  Tag,
  Drawer,
  Descriptions,
  Typography,
  Timeline,
  Row,
  Col,
  Statistic,
  Modal,
  Form,
  message,
} from 'antd';
import {
  SearchOutlined,
  EyeOutlined,
  CarOutlined,
  UserOutlined,
  EnvironmentOutlined,
  DollarOutlined,
  ClockCircleOutlined,
  CheckCircleOutlined,
  CloseCircleOutlined,
  ExclamationCircleOutlined,
  ReloadOutlined,
  ShoppingCartOutlined,
} from '@ant-design/icons';
import { useDispatch, useSelector } from 'react-redux';
import { fetchOrders } from '../store/slices/ordersSlice';
import { type RootState, type AppDispatch } from '../store';
import { type Order } from '../types';
import dayjs from 'dayjs';

const { Search } = Input;
const { Option } = Select;
const { RangePicker } = DatePicker;
const { Title, Text } = Typography;

const Orders: React.FC = () => {
  const dispatch = useDispatch<AppDispatch>();
  const { orders, loading, pagination } = useSelector(
    (state: RootState) => state.orders
  );

  const [searchText, setSearchText] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [dateRange, setDateRange] = useState<[dayjs.Dayjs | null, dayjs.Dayjs | null] | null>(null);
  const [isDrawerVisible, setIsDrawerVisible] = useState(false);
  const [selectedOrder, setSelectedOrder] = useState<Order | null>(null);
  const [isDisputeModalVisible, setIsDisputeModalVisible] = useState(false);
  const [disputeForm] = Form.useForm();

  useEffect(() => {
    loadOrders();
  }, []);

  const loadOrders = () => {
    dispatch(fetchOrders({
      filters: {
        search: searchText,
        status: statusFilter === 'all' ? undefined : statusFilter,
        startDate: dateRange?.[0]?.format('YYYY-MM-DD'),
        endDate: dateRange?.[1]?.format('YYYY-MM-DD'),
      },
      page: pagination.page,
      pageSize: pagination.pageSize,
    }));
  };

  const handleViewOrder = (order: Order) => {
    setSelectedOrder(order);
    setIsDrawerVisible(true);
  };

  const handleResolveDispute = (order: Order) => {
    setSelectedOrder(order);
    setIsDisputeModalVisible(true);
  };

  const handleDisputeSubmit = async () => {
    try {
      const values = await disputeForm.validateFields();
      // TODO: 調用 API 解決糾紛
      message.success('糾紛處理成功！');
      setIsDisputeModalVisible(false);
      disputeForm.resetFields();
      loadOrders();
    } catch (error) {
      message.error('處理失敗！');
    }
  };

  const getStatusTag = (status: string) => {
    const statusMap: { [key: string]: { color: string; text: string; icon: React.ReactNode } } = {
      pending: { color: 'default', text: '等待中', icon: <ClockCircleOutlined /> },
      accepted: { color: 'processing', text: '已接單', icon: <CarOutlined /> },
      arrived: { color: 'cyan', text: '已到達', icon: <EnvironmentOutlined /> },
      picked_up: { color: 'blue', text: '已上車', icon: <UserOutlined /> },
      completed: { color: 'success', text: '已完成', icon: <CheckCircleOutlined /> },
      cancelled: { color: 'error', text: '已取消', icon: <CloseCircleOutlined /> },
    };
    const config = statusMap[status] || { color: 'default', text: status, icon: null };
    return (
      <Tag color={config.color}>
        {config.icon} {config.text}
      </Tag>
    );
  };

  const getPaymentTag = (method: string, status: string) => {
    const methodMap: { [key: string]: string } = {
      cash: '現金',
      card: '信用卡',
      wallet: '電子錢包',
    };
    const statusColor = status === 'completed' ? 'success' : status === 'failed' ? 'error' : 'warning';
    return (
      <Space>
        <Tag>{methodMap[method] || method}</Tag>
        <Tag color={statusColor}>{status === 'completed' ? '已支付' : status === 'failed' ? '失敗' : '待支付'}</Tag>
      </Space>
    );
  };

  const columns = [
    {
      title: '訂單編號',
      dataIndex: 'order_id',
      key: 'order_id',
      width: 120,
      render: (id: string) => (
        <a onClick={() => handleViewOrder({ order_id: id } as Order)}>
          {id.slice(0, 10)}...
        </a>
      ),
    },
    {
      title: '乘客',
      dataIndex: 'passenger_id',
      key: 'passenger_id',
      render: (id: string) => (
        <Space>
          <UserOutlined />
          {`乘客 ${id.slice(-4)}`}
        </Space>
      ),
    },
    {
      title: '司機',
      dataIndex: 'driver_id',
      key: 'driver_id',
      render: (id: string) => id ? `司機 ${id.slice(-4)}` : '-',
    },
    {
      title: '狀態',
      dataIndex: 'status',
      key: 'status',
      render: (status: string) => getStatusTag(status),
    },
    {
      title: '起點',
      dataIndex: 'pickupLocation',
      key: 'pickupLocation',
      ellipsis: true,
      render: (location: any) => location?.address || '-',
    },
    {
      title: '終點',
      dataIndex: 'dropoffLocation',
      key: 'dropoffLocation',
      ellipsis: true,
      render: (location: any) => location?.address || '-',
    },
    {
      title: '車資',
      dataIndex: 'fare',
      key: 'fare',
      render: (fare: number) => fare > 0 ? `$${fare}` : '-',
    },
    {
      title: '支付',
      key: 'payment',
      render: (_: any, record: Order) => getPaymentTag(record.paymentMethod, record.paymentStatus),
    },
    {
      title: '建立時間',
      dataIndex: 'createdAt',
      key: 'createdAt',
      render: (time: string) => dayjs(time).format('MM/DD HH:mm'),
    },
    {
      title: '操作',
      key: 'action',
      width: 120,
      render: (_: any, record: Order) => (
        <Space size="small">
          <Button
            size="small"
            icon={<EyeOutlined />}
            onClick={() => handleViewOrder(record)}
          />
          {record.status === 'completed' && record.rating && record.rating < 3 && (
            <Button
              size="small"
              icon={<ExclamationCircleOutlined />}
              danger
              onClick={() => handleResolveDispute(record)}
            >
              處理糾紛
            </Button>
          )}
        </Space>
      ),
    },
  ];

  return (
    <div>
      <Card>
        <Row gutter={16} style={{ marginBottom: 24 }}>
          <Col span={6}>
            <Card>
              <Statistic
                title="今日訂單"
                value={orders.filter(o => dayjs(o.createdAt).isSame(dayjs(), 'day')).length}
                prefix={<ShoppingCartOutlined />}
              />
            </Card>
          </Col>
          <Col span={6}>
            <Card>
              <Statistic
                title="進行中"
                value={orders.filter(o => ['accepted', 'arrived', 'picked_up'].includes(o.status)).length}
                valueStyle={{ color: '#1890ff' }}
                prefix={<ClockCircleOutlined />}
              />
            </Card>
          </Col>
          <Col span={6}>
            <Card>
              <Statistic
                title="已完成"
                value={orders.filter(o => o.status === 'completed').length}
                valueStyle={{ color: '#3f8600' }}
                prefix={<CheckCircleOutlined />}
              />
            </Card>
          </Col>
          <Col span={6}>
            <Card>
              <Statistic
                title="已取消"
                value={orders.filter(o => o.status === 'cancelled').length}
                valueStyle={{ color: '#cf1322' }}
                prefix={<CloseCircleOutlined />}
              />
            </Card>
          </Col>
        </Row>

        <div style={{ marginBottom: 16 }}>
          <Space size="middle">
            <Search
              placeholder="搜尋訂單編號、乘客或司機"
              allowClear
              enterButton={<SearchOutlined />}
              size="middle"
              style={{ width: 300 }}
              onSearch={(value) => {
                setSearchText(value);
                loadOrders();
              }}
            />
            <Select
              defaultValue="all"
              style={{ width: 120 }}
              onChange={(value) => {
                setStatusFilter(value);
                loadOrders();
              }}
            >
              <Option value="all">全部狀態</Option>
              <Option value="pending">等待中</Option>
              <Option value="accepted">已接單</Option>
              <Option value="picked_up">已上車</Option>
              <Option value="completed">已完成</Option>
              <Option value="cancelled">已取消</Option>
            </Select>
            <RangePicker
              onChange={(dates) => {
                setDateRange(dates as [dayjs.Dayjs | null, dayjs.Dayjs | null] | null);
                loadOrders();
              }}
            />
            <Button icon={<ReloadOutlined />} onClick={loadOrders}>
              刷新
            </Button>
          </Space>
        </div>

        <Table
          columns={columns}
          dataSource={orders}
          rowKey="order_id"
          loading={loading}
          pagination={{
            current: pagination.page,
            pageSize: pagination.pageSize,
            total: pagination.total,
            showSizeChanger: true,
            showTotal: (total) => `共 ${total} 筆`,
            onChange: (page, pageSize) => {
              dispatch(fetchOrders({
                filters: {
                  search: searchText,
                  status: statusFilter === 'all' ? undefined : statusFilter,
                  startDate: dateRange?.[0]?.format('YYYY-MM-DD'),
                  endDate: dateRange?.[1]?.format('YYYY-MM-DD'),
                },
                page,
                pageSize,
              }));
            },
          }}
        />
      </Card>

      {/* 訂單詳情 Drawer */}
      <Drawer
        title="訂單詳細資料"
        width={700}
        visible={isDrawerVisible}
        onClose={() => setIsDrawerVisible(false)}
      >
        {selectedOrder && (
          <div>
            <Descriptions title="訂單資訊" bordered column={2}>
              <Descriptions.Item label="訂單編號" span={2}>
                {selectedOrder.order_id}
              </Descriptions.Item>
              <Descriptions.Item label="狀態">
                {getStatusTag(selectedOrder.status)}
              </Descriptions.Item>
              <Descriptions.Item label="建立時間">
                {dayjs(selectedOrder.createdAt).format('YYYY-MM-DD HH:mm:ss')}
              </Descriptions.Item>
            </Descriptions>

            <Descriptions title="行程資訊" bordered column={1} style={{ marginTop: 24 }}>
              <Descriptions.Item label="起點">
                <Space>
                  <EnvironmentOutlined />
                  {selectedOrder.pickupLocation?.address}
                </Space>
              </Descriptions.Item>
              <Descriptions.Item label="終點">
                <Space>
                  <EnvironmentOutlined />
                  {selectedOrder.dropoffLocation?.address}
                </Space>
              </Descriptions.Item>
              <Descriptions.Item label="距離">
                {selectedOrder.distance ? `${selectedOrder.distance} 公里` : '-'}
              </Descriptions.Item>
              <Descriptions.Item label="時長">
                {selectedOrder.duration ? `${selectedOrder.duration} 分鐘` : '-'}
              </Descriptions.Item>
            </Descriptions>

            <Descriptions title="費用資訊" bordered column={2} style={{ marginTop: 24 }}>
              <Descriptions.Item label="車資">
                ${selectedOrder.fare || 0}
              </Descriptions.Item>
              <Descriptions.Item label="支付方式">
                {getPaymentTag(selectedOrder.paymentMethod, selectedOrder.paymentStatus)}
              </Descriptions.Item>
            </Descriptions>

            <Title level={5} style={{ marginTop: 24 }}>訂單時間軸</Title>
            <Timeline>
              <Timeline.Item color="green">
                訂單建立 - {dayjs(selectedOrder.createdAt).format('HH:mm:ss')}
              </Timeline.Item>
              {selectedOrder.acceptedAt && (
                <Timeline.Item color="blue">
                  司機接單 - {dayjs(selectedOrder.acceptedAt).format('HH:mm:ss')}
                </Timeline.Item>
              )}
              {selectedOrder.completedAt && (
                <Timeline.Item color="green">
                  訂單完成 - {dayjs(selectedOrder.completedAt).format('HH:mm:ss')}
                </Timeline.Item>
              )}
              {selectedOrder.cancelledAt && (
                <Timeline.Item color="red">
                  訂單取消 - {dayjs(selectedOrder.cancelledAt).format('HH:mm:ss')}
                  {selectedOrder.cancelReason && ` (原因: ${selectedOrder.cancelReason})`}
                </Timeline.Item>
              )}
            </Timeline>

            {selectedOrder.rating && (
              <Descriptions title="評價資訊" bordered column={1} style={{ marginTop: 24 }}>
                <Descriptions.Item label="評分">
                  {selectedOrder.rating} 星
                </Descriptions.Item>
                {selectedOrder.feedback && (
                  <Descriptions.Item label="評價內容">
                    {selectedOrder.feedback}
                  </Descriptions.Item>
                )}
              </Descriptions>
            )}
          </div>
        )}
      </Drawer>

      {/* 糾紛處理 Modal */}
      <Modal
        title="處理訂單糾紛"
        visible={isDisputeModalVisible}
        onOk={handleDisputeSubmit}
        onCancel={() => {
          setIsDisputeModalVisible(false);
          disputeForm.resetFields();
        }}
        width={600}
      >
        <Form form={disputeForm} layout="vertical">
          <Form.Item label="訂單編號">
            <Input value={selectedOrder?.order_id} disabled />
          </Form.Item>
          <Form.Item
            label="處理方式"
            name="resolution"
            rules={[{ required: true, message: '請選擇處理方式' }]}
          >
            <Select placeholder="請選擇處理方式">
              <Option value="refund_full">全額退款</Option>
              <Option value="refund_partial">部分退款</Option>
              <Option value="compensate">補償優惠券</Option>
              <Option value="warning_driver">警告司機</Option>
              <Option value="warning_passenger">警告乘客</Option>
              <Option value="no_action">不處理</Option>
            </Select>
          </Form.Item>
          <Form.Item
            label="處理說明"
            name="notes"
            rules={[{ required: true, message: '請輸入處理說明' }]}
          >
            <Input.TextArea rows={4} placeholder="請詳細說明處理原因和結果..." />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
};

export default Orders;