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
  App as AntdApp,
  Drawer,
  Descriptions,
  Badge,
  Popconfirm,
  Typography,
  Row,
  Col,
  Statistic,
  Divider,
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
  TeamOutlined,
  DeleteOutlined,
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
import { type Driver, type Team } from '../types';
import { teamsAPI, driverAPI } from '../services/api';

const { Search, TextArea } = Input;
const { Option } = Select;
const { Title } = Typography;

// ===================================================================
// 常數：與後端 src/utils/validators.ts 對齊
// ===================================================================
const ORDER_TYPE_OPTIONS: Array<{ value: string; label: string }> = [
  { value: 'CASH', label: '一般現金單' },
  { value: 'CREDIT_CARD', label: '刷卡單' },
  { value: 'SENIOR_CARD', label: '敬老卡' },
  { value: 'LOVE_CARD', label: '愛心卡' },
  { value: 'WHEELCHAIR', label: '輪椅單' },
  { value: 'PET', label: '寵物單' },
  { value: 'LONG_DISTANCE', label: '長途單' },
  { value: 'NIGHT', label: '夜間單' },
];
const ORDER_TYPE_LABEL: Record<string, string> = Object.fromEntries(
  ORDER_TYPE_OPTIONS.map((o) => [o.value, o.label])
);

const REBATE_LEVEL_OPTIONS: Array<{ value: number; label: string }> = [
  { value: 0, label: '0 元（原價單）' },
  { value: 5, label: '5 元' },
  { value: 10, label: '10 元' },
  { value: 15, label: '15 元' },
  { value: 20, label: '20 元' },
  { value: 30, label: '30 元以上' },
];

const DRIVER_TYPE_OPTIONS: Array<{ value: string; label: string }> = [
  { value: 'HIGH_VOLUME', label: '高量司機' },
  { value: 'REGULAR', label: '一般司機' },
  { value: 'PART_TIME', label: '兼職司機' },
  { value: 'CONTRACT', label: '合約司機' },
];
const DRIVER_TYPE_LABEL: Record<string, string> = Object.fromEntries(
  DRIVER_TYPE_OPTIONS.map((o) => [o.value, o.label])
);

const ACCOUNT_STATUS_OPTIONS: Array<{ value: string; label: string; color: string }> = [
  { value: 'ACTIVE', label: '啟用', color: 'green' },
  { value: 'PENDING', label: '待審核', color: 'gold' },
  { value: 'SUSPENDED', label: '停權', color: 'orange' },
  { value: 'ARCHIVED', label: '封存', color: 'default' },
];

const CAR_COLORS = ['白', '黑', '銀', '灰', '紅', '藍', '綠', '黃', '橙', '紫', '棕', '其他'];

// runtime 狀態（司機 App 自控）對應中文
const AVAILABILITY_LABEL: Record<string, string> = {
  AVAILABLE: '可接單',
  available: '可接單',
  REST: '休息中',
  ON_TRIP: '載客中',
  busy: '載客中',
  OFFLINE: '離線',
  offline: '離線',
};
const AVAILABILITY_COLOR: Record<string, string> = {
  AVAILABLE: 'green',
  available: 'green',
  REST: 'blue',
  ON_TRIP: 'orange',
  busy: 'orange',
  OFFLINE: 'default',
  offline: 'default',
};

// ===================================================================

const Drivers: React.FC = () => {
  // Ant Design 5 建議用 App.useApp() 取得 context-aware message，
  // 靜態 import { message } from 'antd' 在某些 ConfigProvider 下 toast 不顯示。
  const { message, modal } = AntdApp.useApp();
  const dispatch = useDispatch<AppDispatch>();
  const { drivers, loading, pagination, selectedDriver } = useSelector(
    (state: RootState) => state.drivers
  );

  const [searchText, setSearchText] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [isModalVisible, setIsModalVisible] = useState(false);
  const [isDrawerVisible, setIsDrawerVisible] = useState(false);
  const [editingDriver, setEditingDriver] = useState<Driver | null>(null);
  const [teams, setTeams] = useState<Team[]>([]);
  const [form] = Form.useForm();

  useEffect(() => {
    loadDrivers();
    loadTeams();
  }, []);

  const loadTeams = async () => {
    try {
      const res = await teamsAPI.getTeams();
      if (res.success && Array.isArray(res.data)) {
        setTeams(res.data);
      }
    } catch (err) {
      // 車隊列表載入失敗不阻塞頁面；Modal 開啟時使用者仍會看到空 Select
      console.error('載入車隊清單失敗', err);
    }
  };

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
    // 新增時預設值
    form.setFieldsValue({
      driverType: 'HIGH_VOLUME',
      accountStatus: 'ACTIVE',
      acceptedOrderTypes: [],
      acceptedRebateLevels: [],
    });
    setIsModalVisible(true);
  };

  const handleEditDriver = (driver: Driver) => {
    setEditingDriver(driver);
    form.setFieldsValue({
      ...driver,
      acceptedOrderTypes: driver.acceptedOrderTypes ?? [],
      acceptedRebateLevels: driver.acceptedRebateLevels ?? [],
    });
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
    } catch (error: any) {
      // 1) Ant Design Form validateFields 擋下 → 把第一個欄位錯誤明確顯示
      //    （原本直接吃掉變成「操作失敗」，使用者以為按鈕壞了）
      if (error?.errorFields && Array.isArray(error.errorFields) && error.errorFields.length > 0) {
        const first = error.errorFields[0];
        const fieldName = Array.isArray(first.name) ? first.name[0] : '';
        const errMsg = first.errors?.[0] || '請確認所有必填欄位';
        const FIELD_LABEL: Record<string, string> = {
          name: '司機姓名',
          phoneNumber: '手機號碼',
          carPlate: '車牌號碼',
          carModel: '車型',
          carColor: '車色',
          licenseNumber: '駕照號碼',
          teamId: '所屬車隊',
          driverType: '司機類型',
          accountStatus: '司機狀態',
        };
        const label = FIELD_LABEL[fieldName] || fieldName || '欄位';
        message.error(`${errMsg}（${label}）`);
        return;
      }
      // 2) Redux thunk rejected → throw Error(response.error || 'Failed to ...')
      //    所以 error.message 會是 server 的 error 訊息
      // 3) axios 錯誤 → error.response.data.error
      const detail =
        error?.response?.data?.error ||
        error?.message ||
        '操作失敗';
      message.error(detail);
    }
  };

  const handleBlockDriver = async (driver: Driver) => {
    modal.confirm({
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
            reason: '違反平台規定',
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

  const handleDeleteDriver = async (driver: Driver) => {
    try {
      const res = await driverAPI.deleteDriver(driver.driver_id);
      if ((res as any)?.success === false) {
        throw new Error((res as any).error || '刪除失敗');
      }
      const counts = (res as any)?.deleted?.counts;
      const extra =
        counts && counts.orders > 0
          ? `（連帶刪除 ${counts.orders} 筆訂單、${counts.ratings} 筆評分、${counts.dispatch_logs} 筆派單紀錄）`
          : '';
      message.success(`已刪除司機「${driver.name}」${extra}`);
      loadDrivers();
    } catch (err: any) {
      message.error(err?.response?.data?.error || err?.message || '刪除失敗');
    }
  };

  const getStatusTag = (status: string, isBlocked: boolean) => {
    if (isBlocked) {
      return <Tag color="red">已封鎖</Tag>;
    }
    return (
      <Tag color={AVAILABILITY_COLOR[status] || 'default'}>
        {AVAILABILITY_LABEL[status] || status || '-'}
      </Tag>
    );
  };

  const columns = [
    {
      title: '司機ID',
      dataIndex: 'driver_id',
      key: 'driver_id',
      width: 100,
      render: (id: string) => <span style={{ fontFamily: 'monospace' }}>{id?.slice(0, 8)}</span>,
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
      title: '所屬車隊',
      dataIndex: 'teamName',
      key: 'teamName',
      render: (teamName: string) =>
        teamName ? <Tag icon={<TeamOutlined />} color="blue">{teamName}</Tag> : <span style={{ color: '#bbb' }}>-</span>,
    },
    {
      title: '司機類型',
      dataIndex: 'driverType',
      key: 'driverType',
      render: (dt: string) =>
        dt ? <Tag color="purple">{DRIVER_TYPE_LABEL[dt] || dt}</Tag> : <span style={{ color: '#bbb' }}>-</span>,
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
      render: (earnings: number) => `NT$${(earnings || 0).toLocaleString()}`,
    },
    {
      title: '操作',
      key: 'action',
      width: 240,
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
          <Popconfirm
            title={`永久刪除司機「${record.name}」？`}
            description={
              <div>
                <div>手機：{record.phoneNumber}</div>
                <div>車牌：{record.carPlate}</div>
                <div style={{ color: '#cf1322', marginTop: 4 }}>
                  ⚠ 此操作無法復原，將一併清除該司機所有訂單、評分、派單紀錄
                </div>
              </div>
            }
            onConfirm={() => handleDeleteDriver(record)}
            okText="確定刪除"
            okType="danger"
            cancelText="取消"
          >
            <Button size="small" icon={<DeleteOutlined />} danger type="text" />
          </Popconfirm>
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
                value={drivers.filter(d => d.status === 'AVAILABLE' || d.status === 'available').length}
                valueStyle={{ color: '#3f8600' }}
                prefix={<CarOutlined />}
              />
            </Card>
          </Col>
          <Col span={6}>
            <Card>
              <Statistic
                title="載客中"
                value={drivers.filter(d => d.status === 'ON_TRIP' || d.status === 'busy').length}
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
              <Option value="AVAILABLE">可接單</Option>
              <Option value="ON_TRIP">載客中</Option>
              <Option value="REST">休息中</Option>
              <Option value="OFFLINE">離線</Option>
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
          scroll={{ x: 1400 }}
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

      {/* 新增/編輯司機 Modal — 寬度 960，三欄網格避免下滑 */}
      <Modal
        title={editingDriver ? '編輯司機' : '新增司機'}
        open={isModalVisible}
        onOk={handleModalOk}
        onCancel={() => setIsModalVisible(false)}
        width={960}
        destroyOnClose
      >
        <Form form={form} layout="vertical">
          {/* ============ 一、基本資料（3 欄 × 2 列）============ */}
          <Title level={5} style={{ marginTop: 0, marginBottom: 12 }}>一、基本資料</Title>
          <Row gutter={16}>
            <Col span={8}>
              <Form.Item
                label="司機姓名"
                name="name"
                rules={[{ required: true, message: '請輸入姓名' }]}
              >
                <Input prefix={<UserOutlined />} placeholder="司機姓名" />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item
                label="手機號碼"
                name="phoneNumber"
                rules={[
                  { required: true, message: '請輸入手機號碼' },
                  { pattern: /^09\d{8}$|^\+8869\d{8}$/, message: '09xxxxxxxx 或 +8869xxxxxxxx' },
                ]}
                tooltip="新司機第一次登入需 Firebase Phone Auth 驗證。若司機回報 ERROR_APP_NOT_AUTHORIZED，請到 Firebase Console → 專案設定 → Android 應用程式，確認 App 的 SHA-1 指紋已登記（debug 和 release 兩把都要）。"
              >
                <Input prefix={<PhoneOutlined />} placeholder="09xxxxxxxx" />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item
                label="車牌號碼"
                name="carPlate"
                rules={[
                  { required: true, message: '請輸入車牌號碼' },
                  { pattern: /^[A-Za-z0-9\-\s]{4,10}$/, message: '車牌格式錯誤（4-10 碼英數字）' },
                ]}
                tooltip="支援台灣各式車牌：ABC-1234、1234-ABC、4 碼純數字 2328、8 碼 ABCD-1234 等"
              >
                <Input prefix={<CarOutlined />} placeholder="例：ABC-1234" />
              </Form.Item>
            </Col>
          </Row>

          <Row gutter={16}>
            <Col span={8}>
              <Form.Item
                label="車型（可自由輸入）"
                name="carModel"
                rules={[{ required: true, message: '請輸入車型' }]}
              >
                <Input placeholder="例：Toyota Altis" />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item
                label="車色"
                name="carColor"
                rules={[{ required: true, message: '請選擇車色' }]}
              >
                <Select placeholder="請選擇車色">
                  {CAR_COLORS.map((c) => (
                    <Option key={c} value={c}>{c}</Option>
                  ))}
                </Select>
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item
                label="駕照號碼（選填）"
                name="licenseNumber"
              >
                <Input prefix={<IdcardOutlined />} placeholder="駕照號碼" />
              </Form.Item>
            </Col>
          </Row>

          <Divider style={{ margin: '8px 0 16px' }} />

          {/* ============ 二、派遣與分類（3 欄 × 1 列）============ */}
          <Title level={5} style={{ marginBottom: 12 }}>二、派遣與分類</Title>
          <Row gutter={16}>
            <Col span={8}>
              <Form.Item
                label="所屬車隊"
                name="teamId"
                rules={[{ required: true, message: '請選擇所屬車隊' }]}
              >
                <Select placeholder="請選擇車隊" loading={teams.length === 0}>
                  {teams.map((t) => (
                    <Option key={t.teamId} value={t.teamId}>{t.name}</Option>
                  ))}
                </Select>
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item
                label="司機類型"
                name="driverType"
                rules={[{ required: true, message: '請選擇司機類型' }]}
              >
                <Select placeholder="請選擇司機類型">
                  {DRIVER_TYPE_OPTIONS.map((o) => (
                    <Option key={o.value} value={o.value}>{o.label}</Option>
                  ))}
                </Select>
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item
                label="司機狀態"
                name="accountStatus"
                rules={[{ required: true, message: '請選擇狀態' }]}
                tooltip="管理員設定的帳號狀態；司機上下線狀態由司機端 App 控制"
              >
                <Select placeholder="請選擇狀態">
                  {ACCOUNT_STATUS_OPTIONS.map((o) => (
                    <Option key={o.value} value={o.value}>{o.label}</Option>
                  ))}
                </Select>
              </Form.Item>
            </Col>
          </Row>

          {/* 可接案件 & 可接回饋金：多選並排 2 欄 */}
          <Row gutter={16}>
            <Col span={12}>
              <Form.Item
                label="可接案件類型（多選）"
                name="acceptedOrderTypes"
                tooltip="勾選此司機能夠接的訂單類別，派單系統會據此過濾"
              >
                <Select mode="multiple" placeholder="請選擇可接案件類型" allowClear maxTagCount="responsive">
                  {ORDER_TYPE_OPTIONS.map((o) => (
                    <Option key={o.value} value={o.value}>{o.label}</Option>
                  ))}
                </Select>
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item
                label="可接受回饋金折減（多選）"
                name="acceptedRebateLevels"
                tooltip="司機能接受的價位級距，用於依案件條件自動篩選符合價格範圍的司機"
              >
                <Select mode="multiple" placeholder="請選擇可接受的折減級距" allowClear maxTagCount="responsive">
                  {REBATE_LEVEL_OPTIONS.map((o) => (
                    <Option key={o.value} value={o.value}>{o.label}</Option>
                  ))}
                </Select>
              </Form.Item>
            </Col>
          </Row>

          <Form.Item
            label="備註"
            name="note"
            style={{ marginBottom: 0 }}
          >
            <TextArea rows={2} placeholder="司機備註（可多行）" />
          </Form.Item>
        </Form>
      </Modal>

      {/* 司機詳情 Drawer */}
      <Drawer
        title="司機詳細資料"
        width={680}
        open={isDrawerVisible}
        onClose={() => setIsDrawerVisible(false)}
      >
        {selectedDriver && (
          <div>
            <Descriptions title="基本資料" bordered column={1}>
              <Descriptions.Item label="司機ID">{selectedDriver.driver_id}</Descriptions.Item>
              <Descriptions.Item label="姓名">{selectedDriver.name}</Descriptions.Item>
              <Descriptions.Item label="電話">{selectedDriver.phoneNumber}</Descriptions.Item>
              <Descriptions.Item label="駕照號碼">{selectedDriver.licenseNumber || '-'}</Descriptions.Item>
              <Descriptions.Item label="即時狀態">
                {getStatusTag(selectedDriver.status, selectedDriver.isBlocked)}
              </Descriptions.Item>
              <Descriptions.Item label="帳號狀態">
                {(() => {
                  const opt = ACCOUNT_STATUS_OPTIONS.find((o) => o.value === selectedDriver.accountStatus);
                  return opt ? <Tag color={opt.color}>{opt.label}</Tag> : <span style={{ color: '#bbb' }}>-</span>;
                })()}
              </Descriptions.Item>
            </Descriptions>

            <Descriptions title="車輛資料" bordered column={1} style={{ marginTop: 24 }}>
              <Descriptions.Item label="車牌號碼">{selectedDriver.carPlate}</Descriptions.Item>
              <Descriptions.Item label="車型">{selectedDriver.carModel || '-'}</Descriptions.Item>
              <Descriptions.Item label="車色">{selectedDriver.carColor || '-'}</Descriptions.Item>
            </Descriptions>

            <Descriptions title="派遣與分類" bordered column={1} style={{ marginTop: 24 }}>
              <Descriptions.Item label="所屬車隊">
                {selectedDriver.teamName ? (
                  <Tag icon={<TeamOutlined />} color="blue">{selectedDriver.teamName}</Tag>
                ) : <span style={{ color: '#bbb' }}>-</span>}
              </Descriptions.Item>
              <Descriptions.Item label="司機類型">
                {selectedDriver.driverType ? (
                  <Tag color="purple">{DRIVER_TYPE_LABEL[selectedDriver.driverType] || selectedDriver.driverType}</Tag>
                ) : <span style={{ color: '#bbb' }}>-</span>}
              </Descriptions.Item>
              <Descriptions.Item label="可接案件類型">
                {selectedDriver.acceptedOrderTypes && selectedDriver.acceptedOrderTypes.length > 0 ? (
                  <Space size={[4, 8]} wrap>
                    {selectedDriver.acceptedOrderTypes.map((t) => (
                      <Tag key={t} color="cyan">{ORDER_TYPE_LABEL[t] || t}</Tag>
                    ))}
                  </Space>
                ) : <span style={{ color: '#bbb' }}>-</span>}
              </Descriptions.Item>
              <Descriptions.Item label="可接受回饋金折減">
                {selectedDriver.acceptedRebateLevels && selectedDriver.acceptedRebateLevels.length > 0 ? (
                  <Space size={[4, 8]} wrap>
                    {selectedDriver.acceptedRebateLevels.map((r) => (
                      <Tag key={r} color="gold">{r} 元</Tag>
                    ))}
                  </Space>
                ) : <span style={{ color: '#bbb' }}>-</span>}
              </Descriptions.Item>
              <Descriptions.Item label="備註">
                {selectedDriver.note ? (
                  <div style={{ whiteSpace: 'pre-wrap' }}>{selectedDriver.note}</div>
                ) : <span style={{ color: '#bbb' }}>-</span>}
              </Descriptions.Item>
            </Descriptions>

            <Descriptions title="營運數據" bordered column={1} style={{ marginTop: 24 }}>
              <Descriptions.Item label="評分">
                {selectedDriver.rating ? selectedDriver.rating.toFixed(1) : 'N/A'}
              </Descriptions.Item>
              <Descriptions.Item label="總行程數">{selectedDriver.totalTrips || 0}</Descriptions.Item>
              <Descriptions.Item label="總收入">
                NT${(selectedDriver.totalEarnings || 0).toLocaleString()}
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
