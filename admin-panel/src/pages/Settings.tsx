import React, { useState } from 'react';
import {
  Card,
  Form,
  Input,
  InputNumber,
  Switch,
  Button,
  Space,
  Typography,
  Divider,
  message,
  Row,
  Col,
  Select,
  Tabs,
  Upload,
  TimePicker,
} from 'antd';
import {
  SaveOutlined,
  ReloadOutlined,
  UploadOutlined,
  SettingOutlined,
  DollarOutlined,
  BellOutlined,
  MailOutlined,
  ApiOutlined,
} from '@ant-design/icons';
import dayjs from 'dayjs';

const { Title, Text, Paragraph } = Typography;
const { Option } = Select;
const { TextArea } = Input;

const Settings: React.FC = () => {
  const [loading, setLoading] = useState(false);
  const [generalForm] = Form.useForm();
  const [fareForm] = Form.useForm();
  const [notificationForm] = Form.useForm();
  const [emailForm] = Form.useForm();

  // 初始設定值
  const initialGeneralSettings = {
    appName: '花蓮計程車',
    companyName: '花蓮計程車服務股份有限公司',
    contactPhone: '03-1234-5678',
    contactEmail: 'service@hualientaxi.com',
    address: '花蓮縣花蓮市中正路123號',
    timezone: 'Asia/Taipei',
    language: 'zh-TW',
    currency: 'TWD',
    maintenanceMode: false,
    allowNewDrivers: true,
    allowNewPassengers: true,
    autoAssign: true,
    maxSearchRadius: 5,
  };

  const initialFareSettings = {
    baseFare: 100,
    perKmRate: 15,
    perMinuteRate: 5,
    minimumFare: 100,
    nightSurcharge: 20,
    nightSurchargeStart: dayjs('22:00', 'HH:mm'),
    nightSurchargeEnd: dayjs('06:00', 'HH:mm'),
    peakHourSurcharge: 30,
    platformFeePercent: 10,
    driverCommission: 85,
    cancellationFee: 50,
    waitingTimeRate: 3,
  };

  const initialNotificationSettings = {
    enablePush: true,
    enableSMS: true,
    enableEmail: true,
    notifyNewOrder: true,
    notifyOrderAccepted: true,
    notifyOrderCompleted: true,
    notifyOrderCancelled: true,
    notifyPaymentReceived: true,
    notifyLowRating: true,
    lowRatingThreshold: 3,
  };

  const initialEmailSettings = {
    smtpHost: 'smtp.gmail.com',
    smtpPort: 587,
    smtpUsername: '',
    smtpPassword: '',
    smtpSecure: true,
    fromEmail: 'noreply@hualientaxi.com',
    fromName: '花蓮計程車',
  };

  const handleGeneralSave = async () => {
    try {
      const values = await generalForm.validateFields();
      setLoading(true);
      // TODO: 調用 API 儲存設定
      setTimeout(() => {
        setLoading(false);
        message.success('一般設定已儲存！');
      }, 1000);
    } catch (error) {
      message.error('儲存失敗！');
    }
  };

  const handleFareSave = async () => {
    try {
      const values = await fareForm.validateFields();
      setLoading(true);
      // TODO: 調用 API 儲存設定
      setTimeout(() => {
        setLoading(false);
        message.success('費率設定已儲存！');
      }, 1000);
    } catch (error) {
      message.error('儲存失敗！');
    }
  };

  const handleNotificationSave = async () => {
    try {
      const values = await notificationForm.validateFields();
      setLoading(true);
      // TODO: 調用 API 儲存設定
      setTimeout(() => {
        setLoading(false);
        message.success('通知設定已儲存！');
      }, 1000);
    } catch (error) {
      message.error('儲存失敗！');
    }
  };

  const handleEmailSave = async () => {
    try {
      const values = await emailForm.validateFields();
      setLoading(true);
      // TODO: 調用 API 儲存設定
      setTimeout(() => {
        setLoading(false);
        message.success('郵件設定已儲存！');
      }, 1000);
    } catch (error) {
      message.error('儲存失敗！');
    }
  };

  const handleTestEmail = async () => {
    message.loading('正在發送測試郵件...', 2);
    setTimeout(() => {
      message.success('測試郵件已發送！');
    }, 2000);
  };

  const tabItems = [
    {
      key: 'general',
      label: (
        <span>
          <SettingOutlined />
          一般設定
        </span>
      ),
      children: (
        <Card>
          <Form
            form={generalForm}
            layout="vertical"
            initialValues={initialGeneralSettings}
          >
            <Title level={4}>基本資訊</Title>
            <Row gutter={16}>
              <Col span={12}>
                <Form.Item
                  label="應用程式名稱"
                  name="appName"
                  rules={[{ required: true }]}
                >
                  <Input />
                </Form.Item>
              </Col>
              <Col span={12}>
                <Form.Item
                  label="公司名稱"
                  name="companyName"
                  rules={[{ required: true }]}
                >
                  <Input />
                </Form.Item>
              </Col>
            </Row>

            <Row gutter={16}>
              <Col span={12}>
                <Form.Item
                  label="聯絡電話"
                  name="contactPhone"
                  rules={[{ required: true }]}
                >
                  <Input />
                </Form.Item>
              </Col>
              <Col span={12}>
                <Form.Item
                  label="聯絡 Email"
                  name="contactEmail"
                  rules={[{ required: true, type: 'email' }]}
                >
                  <Input />
                </Form.Item>
              </Col>
            </Row>

            <Form.Item
              label="公司地址"
              name="address"
            >
              <TextArea rows={2} />
            </Form.Item>

            <Row gutter={16}>
              <Col span={8}>
                <Form.Item
                  label="時區"
                  name="timezone"
                >
                  <Select>
                    <Option value="Asia/Taipei">台北 (GMT+8)</Option>
                    <Option value="Asia/Tokyo">東京 (GMT+9)</Option>
                  </Select>
                </Form.Item>
              </Col>
              <Col span={8}>
                <Form.Item
                  label="語言"
                  name="language"
                >
                  <Select>
                    <Option value="zh-TW">繁體中文</Option>
                    <Option value="zh-CN">简体中文</Option>
                    <Option value="en">English</Option>
                  </Select>
                </Form.Item>
              </Col>
              <Col span={8}>
                <Form.Item
                  label="貨幣"
                  name="currency"
                >
                  <Select>
                    <Option value="TWD">TWD (台幣)</Option>
                    <Option value="USD">USD (美金)</Option>
                  </Select>
                </Form.Item>
              </Col>
            </Row>

            <Divider />

            <Title level={4}>系統設定</Title>
            <Row gutter={16}>
              <Col span={8}>
                <Form.Item
                  label="維護模式"
                  name="maintenanceMode"
                  valuePropName="checked"
                >
                  <Switch checkedChildren="開啟" unCheckedChildren="關閉" />
                </Form.Item>
              </Col>
              <Col span={8}>
                <Form.Item
                  label="允許新司機註冊"
                  name="allowNewDrivers"
                  valuePropName="checked"
                >
                  <Switch checkedChildren="允許" unCheckedChildren="禁止" />
                </Form.Item>
              </Col>
              <Col span={8}>
                <Form.Item
                  label="允許新乘客註冊"
                  name="allowNewPassengers"
                  valuePropName="checked"
                >
                  <Switch checkedChildren="允許" unCheckedChildren="禁止" />
                </Form.Item>
              </Col>
            </Row>

            <Row gutter={16}>
              <Col span={12}>
                <Form.Item
                  label="自動派單"
                  name="autoAssign"
                  valuePropName="checked"
                >
                  <Switch checkedChildren="開啟" unCheckedChildren="關閉" />
                </Form.Item>
              </Col>
              <Col span={12}>
                <Form.Item
                  label="最大搜索半徑 (公里)"
                  name="maxSearchRadius"
                >
                  <InputNumber min={1} max={20} style={{ width: '100%' }} />
                </Form.Item>
              </Col>
            </Row>

            <Divider />

            <Form.Item>
              <Space>
                <Button
                  type="primary"
                  icon={<SaveOutlined />}
                  onClick={handleGeneralSave}
                  loading={loading}
                >
                  儲存設定
                </Button>
                <Button icon={<ReloadOutlined />}>
                  重設
                </Button>
              </Space>
            </Form.Item>
          </Form>
        </Card>
      ),
    },
    {
      key: 'fare',
      label: (
        <span>
          <DollarOutlined />
          費率設定
        </span>
      ),
      children: (
        <Card>
          <Form
            form={fareForm}
            layout="vertical"
            initialValues={initialFareSettings}
          >
            <Title level={4}>基本費率</Title>
            <Row gutter={16}>
              <Col span={8}>
                <Form.Item
                  label="起步價 (元)"
                  name="baseFare"
                  rules={[{ required: true }]}
                >
                  <InputNumber min={0} style={{ width: '100%' }} />
                </Form.Item>
              </Col>
              <Col span={8}>
                <Form.Item
                  label="每公里費率 (元)"
                  name="perKmRate"
                  rules={[{ required: true }]}
                >
                  <InputNumber min={0} style={{ width: '100%' }} />
                </Form.Item>
              </Col>
              <Col span={8}>
                <Form.Item
                  label="每分鐘費率 (元)"
                  name="perMinuteRate"
                  rules={[{ required: true }]}
                >
                  <InputNumber min={0} style={{ width: '100%' }} />
                </Form.Item>
              </Col>
            </Row>

            <Row gutter={16}>
              <Col span={12}>
                <Form.Item
                  label="最低收費 (元)"
                  name="minimumFare"
                  rules={[{ required: true }]}
                >
                  <InputNumber min={0} style={{ width: '100%' }} />
                </Form.Item>
              </Col>
              <Col span={12}>
                <Form.Item
                  label="等候時間費率 (元/分鐘)"
                  name="waitingTimeRate"
                >
                  <InputNumber min={0} style={{ width: '100%' }} />
                </Form.Item>
              </Col>
            </Row>

            <Divider />

            <Title level={4}>加成設定</Title>
            <Row gutter={16}>
              <Col span={8}>
                <Form.Item
                  label="夜間加成 (%)"
                  name="nightSurcharge"
                >
                  <InputNumber min={0} max={100} style={{ width: '100%' }} />
                </Form.Item>
              </Col>
              <Col span={8}>
                <Form.Item
                  label="夜間開始時間"
                  name="nightSurchargeStart"
                >
                  <TimePicker format="HH:mm" style={{ width: '100%' }} />
                </Form.Item>
              </Col>
              <Col span={8}>
                <Form.Item
                  label="夜間結束時間"
                  name="nightSurchargeEnd"
                >
                  <TimePicker format="HH:mm" style={{ width: '100%' }} />
                </Form.Item>
              </Col>
            </Row>

            <Row gutter={16}>
              <Col span={12}>
                <Form.Item
                  label="尖峰時段加成 (%)"
                  name="peakHourSurcharge"
                >
                  <InputNumber min={0} max={100} style={{ width: '100%' }} />
                </Form.Item>
              </Col>
              <Col span={12}>
                <Form.Item
                  label="取消訂單費用 (元)"
                  name="cancellationFee"
                >
                  <InputNumber min={0} style={{ width: '100%' }} />
                </Form.Item>
              </Col>
            </Row>

            <Divider />

            <Title level={4}>平台抽成</Title>
            <Row gutter={16}>
              <Col span={12}>
                <Form.Item
                  label="平台手續費 (%)"
                  name="platformFeePercent"
                  rules={[{ required: true }]}
                >
                  <InputNumber min={0} max={100} style={{ width: '100%' }} />
                </Form.Item>
              </Col>
              <Col span={12}>
                <Form.Item
                  label="司機分潤 (%)"
                  name="driverCommission"
                  rules={[{ required: true }]}
                >
                  <InputNumber min={0} max={100} style={{ width: '100%' }} />
                </Form.Item>
              </Col>
            </Row>

            <Divider />

            <Form.Item>
              <Space>
                <Button
                  type="primary"
                  icon={<SaveOutlined />}
                  onClick={handleFareSave}
                  loading={loading}
                >
                  儲存設定
                </Button>
                <Button icon={<ReloadOutlined />}>
                  重設
                </Button>
              </Space>
            </Form.Item>
          </Form>
        </Card>
      ),
    },
    {
      key: 'notification',
      label: (
        <span>
          <BellOutlined />
          通知設定
        </span>
      ),
      children: (
        <Card>
          <Form
            form={notificationForm}
            layout="vertical"
            initialValues={initialNotificationSettings}
          >
            <Title level={4}>通知渠道</Title>
            <Row gutter={16}>
              <Col span={8}>
                <Form.Item
                  label="推播通知"
                  name="enablePush"
                  valuePropName="checked"
                >
                  <Switch checkedChildren="開啟" unCheckedChildren="關閉" />
                </Form.Item>
              </Col>
              <Col span={8}>
                <Form.Item
                  label="簡訊通知"
                  name="enableSMS"
                  valuePropName="checked"
                >
                  <Switch checkedChildren="開啟" unCheckedChildren="關閉" />
                </Form.Item>
              </Col>
              <Col span={8}>
                <Form.Item
                  label="Email 通知"
                  name="enableEmail"
                  valuePropName="checked"
                >
                  <Switch checkedChildren="開啟" unCheckedChildren="關閉" />
                </Form.Item>
              </Col>
            </Row>

            <Divider />

            <Title level={4}>通知事件</Title>
            <Row gutter={16}>
              <Col span={12}>
                <Form.Item
                  label="新訂單通知"
                  name="notifyNewOrder"
                  valuePropName="checked"
                >
                  <Switch />
                </Form.Item>
              </Col>
              <Col span={12}>
                <Form.Item
                  label="接單通知"
                  name="notifyOrderAccepted"
                  valuePropName="checked"
                >
                  <Switch />
                </Form.Item>
              </Col>
            </Row>

            <Row gutter={16}>
              <Col span={12}>
                <Form.Item
                  label="完成訂單通知"
                  name="notifyOrderCompleted"
                  valuePropName="checked"
                >
                  <Switch />
                </Form.Item>
              </Col>
              <Col span={12}>
                <Form.Item
                  label="取消訂單通知"
                  name="notifyOrderCancelled"
                  valuePropName="checked"
                >
                  <Switch />
                </Form.Item>
              </Col>
            </Row>

            <Row gutter={16}>
              <Col span={12}>
                <Form.Item
                  label="收到款項通知"
                  name="notifyPaymentReceived"
                  valuePropName="checked"
                >
                  <Switch />
                </Form.Item>
              </Col>
              <Col span={12}>
                <Form.Item
                  label="低評分警告"
                  name="notifyLowRating"
                  valuePropName="checked"
                >
                  <Switch />
                </Form.Item>
              </Col>
            </Row>

            <Form.Item
              label="低評分門檻"
              name="lowRatingThreshold"
            >
              <InputNumber min={1} max={5} style={{ width: 200 }} />
            </Form.Item>

            <Divider />

            <Form.Item>
              <Space>
                <Button
                  type="primary"
                  icon={<SaveOutlined />}
                  onClick={handleNotificationSave}
                  loading={loading}
                >
                  儲存設定
                </Button>
                <Button icon={<ReloadOutlined />}>
                  重設
                </Button>
              </Space>
            </Form.Item>
          </Form>
        </Card>
      ),
    },
    {
      key: 'email',
      label: (
        <span>
          <MailOutlined />
          郵件設定
        </span>
      ),
      children: (
        <Card>
          <Form
            form={emailForm}
            layout="vertical"
            initialValues={initialEmailSettings}
          >
            <Title level={4}>SMTP 設定</Title>
            <Row gutter={16}>
              <Col span={12}>
                <Form.Item
                  label="SMTP 主機"
                  name="smtpHost"
                  rules={[{ required: true }]}
                >
                  <Input placeholder="smtp.gmail.com" />
                </Form.Item>
              </Col>
              <Col span={12}>
                <Form.Item
                  label="SMTP 埠號"
                  name="smtpPort"
                  rules={[{ required: true }]}
                >
                  <InputNumber min={1} max={65535} style={{ width: '100%' }} />
                </Form.Item>
              </Col>
            </Row>

            <Row gutter={16}>
              <Col span={12}>
                <Form.Item
                  label="使用者名稱"
                  name="smtpUsername"
                  rules={[{ required: true }]}
                >
                  <Input />
                </Form.Item>
              </Col>
              <Col span={12}>
                <Form.Item
                  label="密碼"
                  name="smtpPassword"
                  rules={[{ required: true }]}
                >
                  <Input.Password />
                </Form.Item>
              </Col>
            </Row>

            <Form.Item
              label="使用 SSL/TLS"
              name="smtpSecure"
              valuePropName="checked"
            >
              <Switch checkedChildren="是" unCheckedChildren="否" />
            </Form.Item>

            <Divider />

            <Title level={4}>寄件人資訊</Title>
            <Row gutter={16}>
              <Col span={12}>
                <Form.Item
                  label="寄件人 Email"
                  name="fromEmail"
                  rules={[{ required: true, type: 'email' }]}
                >
                  <Input />
                </Form.Item>
              </Col>
              <Col span={12}>
                <Form.Item
                  label="寄件人名稱"
                  name="fromName"
                  rules={[{ required: true }]}
                >
                  <Input />
                </Form.Item>
              </Col>
            </Row>

            <Divider />

            <Form.Item>
              <Space>
                <Button
                  type="primary"
                  icon={<SaveOutlined />}
                  onClick={handleEmailSave}
                  loading={loading}
                >
                  儲存設定
                </Button>
                <Button icon={<MailOutlined />} onClick={handleTestEmail}>
                  發送測試郵件
                </Button>
                <Button icon={<ReloadOutlined />}>
                  重設
                </Button>
              </Space>
            </Form.Item>
          </Form>
        </Card>
      ),
    },
  ];

  return (
    <div>
      <Title level={2} style={{ marginBottom: 24 }}>系統設定</Title>
      <Tabs defaultActiveKey="general" items={tabItems} />
    </div>
  );
};

export default Settings;
