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
  DatePicker,
  TimePicker,
  Upload,
  Switch,
  Image,
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
  UploadOutlined,
  ClockCircleOutlined,
  SafetyCertificateOutlined,
} from '@ant-design/icons';
import dayjs from 'dayjs';
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
  { value: 'FOLDING_WHEELCHAIR', label: '折疊輪椅單' },
  { value: 'PET', label: '寵物單' },
  { value: 'PET_CAGED', label: '寵物有籠單' },
  { value: 'PET_UNCAGED', label: '寵物無籠單' },
  { value: 'LONG_DISTANCE', label: '長途單' },
  { value: 'SHORT_TRIP', label: '短途單' },
  { value: 'NIGHT', label: '夜間單' },
  { value: 'BICYCLE', label: '腳踏車單' },
];
const ORDER_TYPE_LABEL: Record<string, string> = Object.fromEntries(
  ORDER_TYPE_OPTIONS.map((o) => [o.value, o.label])
);

const REBATE_LEVEL_OPTIONS: Array<{ value: number; label: string }> = [
  { value: 0, label: '外調車輛（車隊忙線可調）' },
  { value: 10, label: '10 元' },
  { value: 20, label: '20 元' },
  { value: 30, label: '30 元' },
  { value: 40, label: '40 元' },
  { value: 50, label: '50 元' },
];

const DRIVER_TYPE_OPTIONS: Array<{ value: string; label: string }> = [
  { value: 'FULL_TIME', label: '全職司機' },
  { value: 'REGULAR', label: '一般司機' },
  { value: 'PART_TIME', label: '兼職司機' },
  { value: 'COOPERATIVE', label: '合作司機' },
  { value: 'SPECIAL', label: '特約司機（可接預約）' },
];
const DRIVER_TYPE_LABEL: Record<string, string> = Object.fromEntries(
  DRIVER_TYPE_OPTIONS.map((o) => [o.value, o.label])
);

const VEHICLE_CAPACITY_OPTIONS: Array<{ value: string; label: string }> = [
  { value: 'CAPACITY_4', label: '四人內' },
  { value: 'CAPACITY_5', label: '五人內' },
  { value: 'CAPACITY_6', label: '六人' },
  { value: 'CAPACITY_8', label: '八人' },
  { value: 'WHEELCHAIR_VEHICLE', label: '無障礙' },
];

const SHIFT_TYPE_OPTIONS: Array<{ value: string; label: string; defaultStart: string; defaultEnd: string }> = [
  { value: 'MORNING',   label: '早班', defaultStart: '06:00', defaultEnd: '12:00' },
  { value: 'AFTERNOON', label: '中班', defaultStart: '12:00', defaultEnd: '18:00' },
  { value: 'EVENING',   label: '晚班', defaultStart: '18:00', defaultEnd: '00:00' },
  { value: 'NIGHT',     label: '夜班', defaultStart: '00:00', defaultEnd: '06:00' },
];

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
      driverType: 'FULL_TIME',
      accountStatus: 'ACTIVE',
      acceptedOrderTypes: [],
      acceptedRebateLevels: [],
      shifts: [],
    });
    setIsModalVisible(true);
  };

  const handleEditDriver = (driver: Driver) => {
    setEditingDriver(driver);
    // dayjs 物件給 DatePicker 用；driver.* 是 ISO 字串
    const toDayjs = (s?: string | null) => (s ? dayjs(s) : undefined);
    form.setFieldsValue({
      ...driver,
      acceptedOrderTypes: driver.acceptedOrderTypes ?? [],
      acceptedRebateLevels: driver.acceptedRebateLevels ?? [],
      registrationReviewDate: toDayjs((driver as any).registrationReviewDate),
      licenseReviewDate: toDayjs((driver as any).licenseReviewDate),
      compulsoryInsuranceExpiry: toDayjs((driver as any).compulsoryInsuranceExpiry),
      voluntaryInsuranceExpiry: toDayjs((driver as any).voluntaryInsuranceExpiry),
      shifts: (driver as any).shifts ?? [],
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

      // dayjs 物件 → YYYY-MM-DD 字串（後端 DATE 欄位需要）
      const dateFields = ['registrationReviewDate', 'licenseReviewDate', 'compulsoryInsuranceExpiry', 'voluntaryInsuranceExpiry'];
      for (const f of dateFields) {
        if (values[f] && typeof values[f].format === 'function') {
          values[f] = values[f].format('YYYY-MM-DD');
        } else if (values[f] === null || values[f] === undefined) {
          values[f] = null;
        }
      }

      // shifts: 過濾掉沒勾 is_active 的，存正規化結構
      if (Array.isArray(values.shifts)) {
        values.shifts = values.shifts.filter((s: any) => s && s.shift_type);
      }

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

          <Form.Item label="備註" name="note">
            <TextArea rows={2} placeholder="司機備註（可多行）" />
          </Form.Item>

          <Divider orientation="left" plain>
            <Space><SafetyCertificateOutlined />證件日期 / 車型</Space>
          </Divider>

          <Row gutter={16}>
            <Col span={12}>
              <Form.Item label="計程車登記證審驗日" name="registrationReviewDate">
                <DatePicker style={{ width: '100%' }} placeholder="選擇日期" format="YYYY-MM-DD" />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item label="駕照檢驗日" name="licenseReviewDate">
                <DatePicker style={{ width: '100%' }} placeholder="選擇日期" format="YYYY-MM-DD" />
              </Form.Item>
            </Col>
          </Row>

          <Row gutter={16}>
            <Col span={12}>
              <Form.Item label="強制險到期日" name="compulsoryInsuranceExpiry">
                <DatePicker style={{ width: '100%' }} placeholder="選擇日期" format="YYYY-MM-DD" />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item label="任意險到期日" name="voluntaryInsuranceExpiry">
                <DatePicker style={{ width: '100%' }} placeholder="選擇日期" format="YYYY-MM-DD" />
              </Form.Item>
            </Col>
          </Row>

          <Form.Item label="車型乘客容量" name="vehicleCapacity">
            <Select placeholder="請選擇車型容量" allowClear>
              {VEHICLE_CAPACITY_OPTIONS.map((o) => (
                <Option key={o.value} value={o.value}>{o.label}</Option>
              ))}
            </Select>
          </Form.Item>

          <Divider orientation="left" plain>
            <Space><ClockCircleOutlined />班次設定（特約司機可接預約單時段）</Space>
          </Divider>

          {/* 班次：固定 4 種，每行勾選 + 開始/結束時間 */}
          <Form.List name="shifts" initialValue={[]}>
            {(_fields, { add, remove }, _meta) => (
              <ShiftsEditor
                form={form}
                onAdd={add}
                onRemove={remove}
              />
            )}
          </Form.List>

          <Divider orientation="left" plain>
            <Space><IdcardOutlined />證件照片（選填）</Space>
          </Divider>

          <Row gutter={16}>
            <Col span={8}>
              <Form.Item label="駕照照片" name="licensePhoto" valuePropName="value">
                <PhotoUploadField label="駕照" />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item label="行照照片" name="vehicleRegistrationPhoto" valuePropName="value">
                <PhotoUploadField label="行照" />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item label="合約書照片" name="contractPhoto" valuePropName="value">
                <PhotoUploadField label="合約書" />
              </Form.Item>
            </Col>
          </Row>
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

/**
 * 班次編輯器 — 4 種班次（早/中/晚/夜），每種可獨立勾選並設定起訖時間
 *
 * Form value: Array<{ shift_type, start, end, is_active }>
 *
 * 為什麼自訂而非用 Form.List：4 種班次數量固定，使用者只需勾選 + 設時段，
 * 不需要動態增刪。用一個固定面板比 Form.List 的「按鈕新增 row」UX 好。
 */
const ShiftsEditor: React.FC<{
  form: any;
  onAdd: (item: any) => void;
  onRemove: (idx: number) => void;
}> = ({ form }) => {
  // 直接讀寫 form.shifts 整個陣列，避免 Form.List 的 index 管理
  const shifts: Array<{ shift_type: string; start: string; end: string; is_active: boolean }> =
    Form.useWatch('shifts', form) || [];

  const updateShift = (shiftType: string, patch: Partial<{ start: string; end: string; is_active: boolean }>) => {
    const existing = shifts.find((s) => s.shift_type === shiftType);
    let next: typeof shifts;
    if (existing) {
      next = shifts.map((s) => (s.shift_type === shiftType ? { ...s, ...patch } : s));
    } else {
      const def = SHIFT_TYPE_OPTIONS.find((o) => o.value === shiftType)!;
      next = [
        ...shifts,
        {
          shift_type: shiftType,
          start: def.defaultStart,
          end: def.defaultEnd,
          is_active: true,
          ...patch,
        },
      ];
    }
    form.setFieldsValue({ shifts: next });
  };

  return (
    <div style={{ background: '#fafafa', padding: 12, borderRadius: 8 }}>
      {SHIFT_TYPE_OPTIONS.map((opt) => {
        const slot = shifts.find((s) => s.shift_type === opt.value);
        const isActive = slot?.is_active ?? false;
        const start = slot?.start ?? opt.defaultStart;
        const end = slot?.end ?? opt.defaultEnd;
        return (
          <Row key={opt.value} gutter={12} align="middle" style={{ marginBottom: 8 }}>
            <Col span={5}>
              <Space>
                <Switch
                  checked={isActive}
                  onChange={(checked) => updateShift(opt.value, { is_active: checked })}
                />
                <span style={{ fontWeight: 500 }}>{opt.label}</span>
              </Space>
            </Col>
            <Col span={9}>
              <TimePicker
                value={dayjs(start, 'HH:mm')}
                format="HH:mm"
                minuteStep={15}
                style={{ width: '100%' }}
                placeholder="開始時間"
                disabled={!isActive}
                onChange={(v) => v && updateShift(opt.value, { start: v.format('HH:mm') })}
              />
            </Col>
            <Col span={1} style={{ textAlign: 'center' }}>~</Col>
            <Col span={9}>
              <TimePicker
                value={dayjs(end, 'HH:mm')}
                format="HH:mm"
                minuteStep={15}
                style={{ width: '100%' }}
                placeholder="結束時間"
                disabled={!isActive}
                onChange={(v) => v && updateShift(opt.value, { end: v.format('HH:mm') })}
              />
            </Col>
          </Row>
        );
      })}
    </div>
  );
};

/**
 * 證件照片上傳元件 — 接受 File，轉 base64，存入 Form value
 *
 * 為什麼用 base64 而非 multipart upload：
 * - 司機數量小（< 1000 人）
 * - 照片需求是「儲存 + 顯示」非高頻存取
 * - 後端用 TEXT 欄位即可，省下 S3 / Storage 整合複雜度
 * - 未來真有效能問題再 migrate
 */
const PhotoUploadField: React.FC<{
  label: string;
  value?: string;
  onChange?: (v: string | null) => void;
}> = ({ label, value, onChange }) => {
  const handleBefore = (file: File) => {
    // 驗證：< 2MB（限制 base64 size）
    if (file.size > 2 * 1024 * 1024) {
      Modal.warning({ title: '檔案過大', content: `${label}照片不可超過 2MB` });
      return Upload.LIST_IGNORE;
    }
    const reader = new FileReader();
    reader.onload = () => onChange?.(reader.result as string);
    reader.readAsDataURL(file);
    return false; // 阻止 antd 自動上傳
  };

  return (
    <div>
      {value ? (
        <div style={{ position: 'relative', display: 'inline-block' }}>
          <Image
            src={value}
            alt={label}
            width={120}
            height={80}
            style={{ objectFit: 'cover', borderRadius: 4 }}
          />
          <Button
            size="small"
            danger
            type="text"
            onClick={() => onChange?.(null)}
            style={{ position: 'absolute', top: 0, right: 0 }}
          >
            清除
          </Button>
        </div>
      ) : (
        <Upload
          beforeUpload={handleBefore}
          showUploadList={false}
          accept="image/*"
        >
          <Button icon={<UploadOutlined />}>上傳{label}</Button>
        </Upload>
      )}
    </div>
  );
};

export default Drivers;
