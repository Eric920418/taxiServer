import React, { useEffect, useState } from 'react';
import {
  Table,
  Button,
  Space,
  Card,
  Input,
  Tag,
  Modal,
  Drawer,
  Descriptions,
  message,
  Popconfirm,
  Typography,
  Row,
  Col,
  Statistic,
} from 'antd';
import {
  SearchOutlined,
  EyeOutlined,
  LockOutlined,
  UnlockOutlined,
  ReloadOutlined,
  UserOutlined,
  PhoneOutlined,
  MailOutlined,
  DollarOutlined,
  CarOutlined,
} from '@ant-design/icons';
import { useDispatch, useSelector } from 'react-redux';
import { fetchPassengers, blockPassenger, unblockPassenger } from '../store/slices/passengersSlice';
import { type RootState, type AppDispatch } from '../store';
import { type Passenger } from '../types';

const { Search } = Input;
const { Title } = Typography;

const Passengers: React.FC = () => {
  const dispatch = useDispatch<AppDispatch>();
  const { passengers, loading, pagination } = useSelector(
    (state: RootState) => state.passengers
  );

  const [searchText, setSearchText] = useState('');
  const [isDrawerVisible, setIsDrawerVisible] = useState(false);
  const [selectedPassenger, setSelectedPassenger] = useState<Passenger | null>(null);

  useEffect(() => {
    loadPassengers();
  }, []);

  const loadPassengers = () => {
    dispatch(fetchPassengers({
      filters: { search: searchText },
      page: pagination.page,
      pageSize: pagination.pageSize,
    }));
  };

  const handleSearch = (value: string) => {
    setSearchText(value);
    dispatch(fetchPassengers({
      filters: { search: value },
      page: 1,
      pageSize: pagination.pageSize,
    }));
  };

  const handleViewPassenger = (passenger: Passenger) => {
    setSelectedPassenger(passenger);
    setIsDrawerVisible(true);
  };

  const handleBlockPassenger = async (passenger: Passenger) => {
    Modal.confirm({
      title: '封鎖乘客',
      content: (
        <div>
          <p>確定要封鎖乘客 {passenger.name} 嗎？</p>
          <Input.TextArea
            rows={3}
            placeholder="請輸入封鎖原因..."
          />
        </div>
      ),
      onOk: async () => {
        try {
          await dispatch(blockPassenger({
            passengerId: passenger.passenger_id,
            reason: '違反平台規定',
          })).unwrap();
          message.success('乘客已被封鎖！');
          loadPassengers();
        } catch (error) {
          message.error('封鎖失敗！');
        }
      },
    });
  };

  const handleUnblockPassenger = async (passenger: Passenger) => {
    try {
      await dispatch(unblockPassenger(passenger.passenger_id)).unwrap();
      message.success('乘客已解除封鎖！');
      loadPassengers();
    } catch (error) {
      message.error('解除封鎖失敗！');
    }
  };

  const getStatusTag = (status: string, isBlocked: boolean) => {
    if (isBlocked) {
      return <Tag color="red">已封鎖</Tag>;
    }
    return <Tag color="green">正常</Tag>;
  };

  const columns = [
    {
      title: '乘客ID',
      dataIndex: 'passenger_id',
      key: 'passenger_id',
      width: 120,
      render: (id: string) => <span style={{ fontFamily: 'monospace' }}>{id}</span>,
    },
    {
      title: '姓名',
      dataIndex: 'name',
      key: 'name',
      render: (name: string) => <strong>{name}</strong>,
    },
    {
      title: '電話',
      dataIndex: 'phoneNumber',
      key: 'phoneNumber',
      render: (phone: string) => (
        <Space>
          <PhoneOutlined />
          {phone}
        </Space>
      ),
    },
    {
      title: 'Email',
      dataIndex: 'email',
      key: 'email',
      render: (email: string) => email || '-',
    },
    {
      title: '狀態',
      dataIndex: 'status',
      key: 'status',
      render: (_: any, record: Passenger) => getStatusTag(record.status, record.isBlocked),
    },
    {
      title: '總行程',
      dataIndex: 'totalTrips',
      key: 'totalTrips',
      render: (trips: number) => trips || 0,
    },
    {
      title: '總花費',
      dataIndex: 'totalSpent',
      key: 'totalSpent',
      render: (spent: number) => `$${(spent || 0).toLocaleString()}`,
    },
    {
      title: '評分',
      dataIndex: 'rating',
      key: 'rating',
      render: (rating: number) => rating ? rating.toFixed(1) : 'N/A',
    },
    {
      title: '操作',
      key: 'action',
      width: 150,
      render: (_: any, record: Passenger) => (
        <Space size="small">
          <Button
            size="small"
            icon={<EyeOutlined />}
            onClick={() => handleViewPassenger(record)}
          />
          {record.isBlocked ? (
            <Popconfirm
              title="確定要解除封鎖嗎？"
              onConfirm={() => handleUnblockPassenger(record)}
              okText="確定"
              cancelText="取消"
            >
              <Button
                size="small"
                icon={<UnlockOutlined />}
                type="primary"
                ghost
              />
            </Popconfirm>
          ) : (
            <Button
              size="small"
              icon={<LockOutlined />}
              danger
              onClick={() => handleBlockPassenger(record)}
            />
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
                title="總乘客數"
                value={pagination.total || 0}
                prefix={<UserOutlined />}
              />
            </Card>
          </Col>
          <Col span={6}>
            <Card>
              <Statistic
                title="活躍乘客"
                value={passengers.filter(p => !p.isBlocked).length}
                valueStyle={{ color: '#3f8600' }}
                prefix={<UserOutlined />}
              />
            </Card>
          </Col>
          <Col span={6}>
            <Card>
              <Statistic
                title="本月新增"
                value={28}
                valueStyle={{ color: '#1890ff' }}
                prefix={<UserOutlined />}
              />
            </Card>
          </Col>
          <Col span={6}>
            <Card>
              <Statistic
                title="封鎖乘客"
                value={passengers.filter(p => p.isBlocked).length}
                valueStyle={{ color: '#cf1322' }}
                prefix={<LockOutlined />}
              />
            </Card>
          </Col>
        </Row>

        <div style={{ marginBottom: 16, display: 'flex', justifyContent: 'space-between' }}>
          <Space>
            <Search
              placeholder="搜尋乘客姓名或電話"
              allowClear
              enterButton={<SearchOutlined />}
              size="middle"
              style={{ width: 300 }}
              onSearch={handleSearch}
            />
          </Space>
          <Button icon={<ReloadOutlined />} onClick={loadPassengers}>
            刷新
          </Button>
        </div>

        <Table
          columns={columns}
          dataSource={passengers}
          rowKey="passenger_id"
          loading={loading}
          pagination={{
            current: pagination.page,
            pageSize: pagination.pageSize,
            total: pagination.total,
            showSizeChanger: true,
            showTotal: (total) => `共 ${total} 筆`,
            onChange: (page, pageSize) => {
              dispatch(fetchPassengers({
                filters: { search: searchText },
                page,
                pageSize,
              }));
            },
          }}
        />
      </Card>

      {/* 乘客詳情 Drawer */}
      <Drawer
        title="乘客詳細資料"
        width={600}
        visible={isDrawerVisible}
        onClose={() => setIsDrawerVisible(false)}
      >
        {selectedPassenger && (
          <div>
            <Descriptions title="基本資料" bordered column={1}>
              <Descriptions.Item label="乘客ID">{selectedPassenger.passenger_id}</Descriptions.Item>
              <Descriptions.Item label="姓名">{selectedPassenger.name}</Descriptions.Item>
              <Descriptions.Item label="電話">{selectedPassenger.phoneNumber}</Descriptions.Item>
              <Descriptions.Item label="Email">{selectedPassenger.email || '未提供'}</Descriptions.Item>
              <Descriptions.Item label="狀態">
                {getStatusTag(selectedPassenger.status, selectedPassenger.isBlocked)}
              </Descriptions.Item>
            </Descriptions>

            <Descriptions title="使用統計" bordered column={1} style={{ marginTop: 24 }}>
              <Descriptions.Item label="總行程數">{selectedPassenger.totalTrips || 0}</Descriptions.Item>
              <Descriptions.Item label="總花費">
                ${(selectedPassenger.totalSpent || 0).toLocaleString()}
              </Descriptions.Item>
              <Descriptions.Item label="評分">
                {selectedPassenger.rating ? selectedPassenger.rating.toFixed(1) : 'N/A'}
              </Descriptions.Item>
              <Descriptions.Item label="註冊時間">{selectedPassenger.createdAt}</Descriptions.Item>
              <Descriptions.Item label="最後活動時間">{selectedPassenger.lastActive}</Descriptions.Item>
            </Descriptions>

            {selectedPassenger.isBlocked && (
              <Descriptions title="封鎖資訊" bordered column={1} style={{ marginTop: 24 }}>
                <Descriptions.Item label="封鎖原因">{selectedPassenger.blockReason}</Descriptions.Item>
              </Descriptions>
            )}

            <div style={{ marginTop: 24 }}>
              <Title level={5}>最近行程記錄</Title>
              <Table
                dataSource={[]}
                columns={[
                  { title: '訂單號', dataIndex: 'orderId' },
                  { title: '司機', dataIndex: 'driver' },
                  { title: '車資', dataIndex: 'fare' },
                  { title: '時間', dataIndex: 'time' },
                ]}
                pagination={false}
                size="small"
                locale={{ emptyText: '暫無行程記錄' }}
              />
            </div>
          </div>
        )}
      </Drawer>
    </div>
  );
};

export default Passengers;