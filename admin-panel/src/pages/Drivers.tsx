import React, { useEffect, useState } from 'react';
import {
  Table,
  Button,
  Space,
  Card,
  Input,
  Select,
  Tag,
  Modal,
  Form,
  message,
  Drawer,
  Descriptions,
  Badge,
  Popconfirm,
  Typography,
  Row,
  Col,
  Statistic,
} from 'antd';
import {
  PlusOutlined,
  SearchOutlined,
  EditOutlined,
  LockOutlined,
  UnlockOutlined,
  EyeOutlined,
  ReloadOutlined,
  CarOutlined,
  PhoneOutlined,
  IdcardOutlined,
  UserOutlined,
} from '@ant-design/icons';
import { useDispatch, useSelector } from 'react-redux';
import {
  fetchDrivers,
  createDriver,
  updateDriver,
  blockDriver,
  unblockDriver,
  fetchDriverById,
} from '../store/slices/driversSlice';
import { type RootState, type AppDispatch } from '../store';
import { type Driver } from '../types';

const { Search } = Input;
const { Option } = Select;

const Drivers: React.FC = () => {
  const dispatch = useDispatch<AppDispatch>();
  const { drivers, loading, pagination, selectedDriver } = useSelector(
    (state: RootState) => state.drivers
  );

  const [searchText, setSearchText] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [isModalVisible, setIsModalVisible] = useState(false);
  const [isDrawerVisible, setIsDrawerVisible] = useState(false);
  const [editingDriver, setEditingDriver] = useState<Driver | null>(null);
  const [form] = Form.useForm();

  useEffect(() => {
    loadDrivers();
  }, []);

  const loadDrivers = () => {
    dispatch(fetchDrivers({
      filters: {
        search: searchText,
        status: statusFilter === 'all' ? undefined : statusFilter
      },
      page: pagination.page,
      pageSize: pagination.pageSize,
    }));
  };

  const handleSearch = (value: string) => {
    setSearchText(value);
    dispatch(fetchDrivers({
      filters: {
        search: value,
        status: statusFilter === 'all' ? undefined : statusFilter
      },
      page: 1,
      pageSize: pagination.pageSize,
    }));
  };

  const handleStatusFilter = (value: string) => {
    setStatusFilter(value);
    dispatch(fetchDrivers({
      filters: {
        search: searchText,
        status: value === 'all' ? undefined : value
      },
      page: 1,
      pageSize: pagination.pageSize,
    }));
  };

  const handleAddDriver = () => {
    setEditingDriver(null);
    form.resetFields();
    setIsModalVisible(true);
  };

  const handleEditDriver = (driver: Driver) => {
    setEditingDriver(driver);
    form.setFieldsValue(driver);
    setIsModalVisible(true);
  };

  const handleViewDriver = async (driver: Driver) => {
    await dispatch(fetchDriverById(driver.driver_id));
    setIsDrawerVisible(true);
  };

  const handleModalOk = async () => {
    try {
      const values = await form.validateFields();
      if (editingDriver) {
        await dispatch(updateDriver({
          driverId: editingDriver.driver_id,
          updates: values,
        })).unwrap();
        message.success('司機資料更新成功！');
      } else {
        await dispatch(createDriver(values)).unwrap();
        message.success('新增司機成功！');
      }
      setIsModalVisible(false);
      loadDrivers();
    } catch (error) {
      message.error('操作失敗！');
    }
  };

  const handleBlockDriver = async (driver: Driver) => {
    Modal.confirm({
      title: '封鎖司機',
      content: (
        <Form layout="vertical">
          <Form.Item
            label="封鎖原因"
            name="reason"
            rules={[{ required: true, message: '請輸入封鎖原因' }]}
          >
            <Input.TextArea rows={3} placeholder="請輸入封鎖原因..." />
          </Form.Item>
        </Form>
      ),
      onOk: async () => {
        try {
          await dispatch(blockDriver({
            driverId: driver.driver_id,
            reason: '違反平台規定', // This should come from the form
          })).unwrap();
          message.success('司機已被封鎖！');
          loadDrivers();
        } catch (error) {
          message.error('封鎖失敗！');
        }
      },
    });
  };

  const handleUnblockDriver = async (driver: Driver) => {
    try {
      await dispatch(unblockDriver(driver.driver_id)).unwrap();
      message.success('司機已解除封鎖！');
      loadDrivers();
    } catch (error) {
      message.error('解除封鎖失敗！');
    }
  };

  const getStatusTag = (status: string, isBlocked: boolean) => {
    if (isBlocked) {
      return <Tag color="red">已封鎖</Tag>;
    }
    const statusMap: { [key: string]: string } = {
      'available': 'green',
      'busy': 'orange',
      'offline': 'default',
    };
    const statusTextMap: { [key: string]: string } = {
      'available': '可接單',
      'busy': '忙碌中',
      'offline': '離線',
    };
    return <Tag color={statusMap[status] || 'default'}>{statusTextMap[status] || status}</Tag>;
  };

  const columns = [
    {
      title: '司機ID',
      dataIndex: 'driver_id',
      key: 'driver_id',
      width: 100,
      render: (id: string) => <span style={{ fontFamily: 'monospace' }}>{id.slice(0, 8)}</span>,
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
      title: '車牌號碼',
      dataIndex: 'carPlate',
      key: 'carPlate',
      render: (plate: string) => (
        <Space>
          <CarOutlined />
          <span style={{ fontWeight: 'bold' }}>{plate}</span>
        </Space>
      ),
    },
    {
      title: '狀態',
      dataIndex: 'status',
      key: 'status',
      render: (_: any, record: Driver) => getStatusTag(record.status, record.isBlocked),
    },
    {
      title: '評分',
      dataIndex: 'rating',
      key: 'rating',
      render: (rating: number) => (
        <Badge
          count={rating ? rating.toFixed(1) : 'N/A'}
          style={{ backgroundColor: rating >= 4 ? '#52c41a' : '#faad14' }}
        />
      ),
    },
    {
      title: '總行程',
      dataIndex: 'totalTrips',
      key: 'totalTrips',
      render: (trips: number) => trips || 0,
    },
    {
      title: '總收入',
      dataIndex: 'totalEarnings',
      key: 'totalEarnings',
      render: (earnings: number) => `$${(earnings || 0).toLocaleString()}`,
    },
    {
      title: '操作',
      key: 'action',
      width: 200,
      render: (_: any, record: Driver) => (
        <Space size="small">
          <Button
            size="small"
            icon={<EyeOutlined />}
            onClick={() => handleViewDriver(record)}
          />
          <Button
            size="small"
            icon={<EditOutlined />}
            onClick={() => handleEditDriver(record)}
          />
          {record.isBlocked ? (
            <Popconfirm
              title="確定要解除封鎖嗎？"
              onConfirm={() => handleUnblockDriver(record)}
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
              onClick={() => handleBlockDriver(record)}
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
                title="總司機數"
                value={pagination.total || 0}
                prefix={<CarOutlined />}
              />
            </Card>
          </Col>
          <Col span={6}>
            <Card>
              <Statistic
                title="在線司機"
                value={drivers.filter(d => d.status === 'available').length}
                valueStyle={{ color: '#3f8600' }}
                prefix={<CarOutlined />}
              />
            </Card>
          </Col>
          <Col span={6}>
            <Card>
              <Statistic
                title="忙碌司機"
                value={drivers.filter(d => d.status === 'busy').length}
                valueStyle={{ color: '#faad14' }}
                prefix={<CarOutlined />}
              />
            </Card>
          </Col>
          <Col span={6}>
            <Card>
              <Statistic
                title="封鎖司機"
                value={drivers.filter(d => d.isBlocked).length}
                valueStyle={{ color: '#cf1322' }}
                prefix={<LockOutlined />}
              />
            </Card>
          </Col>
        </Row>

        <div style={{ marginBottom: 16, display: 'flex', justifyContent: 'space-between' }}>
          <Space>
            <Search
              placeholder="搜尋司機姓名、電話或車牌"
              allowClear
              enterButton={<SearchOutlined />}
              size="middle"
              style={{ width: 300 }}
              onSearch={handleSearch}
            />
            <Select
              defaultValue="all"
              style={{ width: 120 }}
              onChange={handleStatusFilter}
            >
              <Option value="all">全部狀態</Option>
              <Option value="available">可接單</Option>
              <Option value="busy">忙碌中</Option>
              <Option value="offline">離線</Option>
              <Option value="blocked">已封鎖</Option>
            </Select>
          </Space>
          <Space>
            <Button icon={<ReloadOutlined />} onClick={loadDrivers}>
              刷新
            </Button>
            <Button type="primary" icon={<PlusOutlined />} onClick={handleAddDriver}>
              新增司機
            </Button>
          </Space>
        </div>

        <Table
          columns={columns}
          dataSource={drivers}
          rowKey="driver_id"
          loading={loading}
          pagination={{
            current: pagination.page,
            pageSize: pagination.pageSize,
            total: pagination.total,
            showSizeChanger: true,
            showTotal: (total) => `共 ${total} 筆`,
            onChange: (page, pageSize) => {
              dispatch(fetchDrivers({
                filters: {
                  search: searchText,
                  status: statusFilter === 'all' ? undefined : statusFilter
                },
                page,
                pageSize,
              }));
            },
          }}
        />
      </Card>

      {/* 新增/編輯司機 Modal */}
      <Modal
        title={editingDriver ? '編輯司機' : '新增司機'}
        visible={isModalVisible}
        onOk={handleModalOk}
        onCancel={() => setIsModalVisible(false)}
        width={600}
      >
        <Form form={form} layout="vertical">
          <Row gutter={16}>
            <Col span={12}>
              <Form.Item
                label="姓名"
                name="name"
                rules={[{ required: true, message: '請輸入姓名' }]}
              >
                <Input prefix={<UserOutlined />} placeholder="司機姓名" />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item
                label="電話號碼"
                name="phoneNumber"
                rules={[
                  { required: true, message: '請輸入電話號碼' },
                  { pattern: /^09\d{8}$/, message: '請輸入有效的手機號碼' },
                ]}
              >
                <Input prefix={<PhoneOutlined />} placeholder="09xxxxxxxx" />
              </Form.Item>
            </Col>
          </Row>
          <Row gutter={16}>
            <Col span={12}>
              <Form.Item
                label="駕照號碼"
                name="licenseNumber"
                rules={[{ required: true, message: '請輸入駕照號碼' }]}
              >
                <Input prefix={<IdcardOutlined />} placeholder="駕照號碼" />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item
                label="車牌號碼"
                name="carPlate"
                rules={[{ required: true, message: '請輸入車牌號碼' }]}
              >
                <Input prefix={<CarOutlined />} placeholder="XXX-0000" />
              </Form.Item>
            </Col>
          </Row>
          <Row gutter={16}>
            <Col span={12}>
              <Form.Item
                label="車型"
                name="carModel"
                rules={[{ required: true, message: '請輸入車型' }]}
              >
                <Input placeholder="例：Toyota Altis" />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item
                label="車色"
                name="carColor"
                rules={[{ required: true, message: '請輸入車色' }]}
              >
                <Input placeholder="例：白色" />
              </Form.Item>
            </Col>
          </Row>
        </Form>
      </Modal>

      {/* 司機詳情 Drawer */}
      <Drawer
        title="司機詳細資料"
        width={600}
        visible={isDrawerVisible}
        onClose={() => setIsDrawerVisible(false)}
      >
        {selectedDriver && (
          <div>
            <Descriptions title="基本資料" bordered column={1}>
              <Descriptions.Item label="司機ID">{selectedDriver.driver_id}</Descriptions.Item>
              <Descriptions.Item label="姓名">{selectedDriver.name}</Descriptions.Item>
              <Descriptions.Item label="電話">{selectedDriver.phoneNumber}</Descriptions.Item>
              <Descriptions.Item label="駕照號碼">{selectedDriver.licenseNumber}</Descriptions.Item>
              <Descriptions.Item label="狀態">
                {getStatusTag(selectedDriver.status, selectedDriver.isBlocked)}
              </Descriptions.Item>
            </Descriptions>

            <Descriptions title="車輛資料" bordered column={1} style={{ marginTop: 24 }}>
              <Descriptions.Item label="車牌號碼">{selectedDriver.carPlate}</Descriptions.Item>
              <Descriptions.Item label="車型">{selectedDriver.carModel}</Descriptions.Item>
              <Descriptions.Item label="車色">{selectedDriver.carColor}</Descriptions.Item>
            </Descriptions>

            <Descriptions title="營運數據" bordered column={1} style={{ marginTop: 24 }}>
              <Descriptions.Item label="評分">
                {selectedDriver.rating ? selectedDriver.rating.toFixed(1) : 'N/A'}
              </Descriptions.Item>
              <Descriptions.Item label="總行程數">{selectedDriver.totalTrips || 0}</Descriptions.Item>
              <Descriptions.Item label="總收入">
                ${(selectedDriver.totalEarnings || 0).toLocaleString()}
              </Descriptions.Item>
              <Descriptions.Item label="註冊時間">{selectedDriver.createdAt}</Descriptions.Item>
              <Descriptions.Item label="最後活動時間">{selectedDriver.lastActive}</Descriptions.Item>
            </Descriptions>

            {selectedDriver.isBlocked && (
              <Descriptions title="封鎖資訊" bordered column={1} style={{ marginTop: 24 }}>
                <Descriptions.Item label="封鎖原因">{selectedDriver.blockReason}</Descriptions.Item>
              </Descriptions>
            )}
          </div>
        )}
      </Drawer>
    </div>
  );
};

export default Drivers;