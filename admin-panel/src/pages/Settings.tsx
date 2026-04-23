import React, { useState, useEffect } from 'react';
import {
  Card,
  Form,
  InputNumber,
  Switch,
  Button,
  Space,
  Typography,
  Divider,
  message,
  Row,
  Col,
  Tabs,
  Spin,
  Alert,
  DatePicker,
} from 'antd';
import {
  SaveOutlined,
  ReloadOutlined,
  SettingOutlined,
  DollarOutlined,
  BellOutlined,
  MailOutlined,
} from '@ant-design/icons';
import dayjs, { Dayjs } from 'dayjs';
import api from '../services/api';

const { Title, Paragraph } = Typography;
const { RangePicker } = DatePicker;

interface DayFareConfig {
  basePrice: number;
  baseDistanceMeters: number;
  jumpDistanceMeters: number;
  jumpPrice: number;
  slowTrafficSeconds: number;
  slowTrafficPrice: number;
}

interface NightFareConfig extends DayFareConfig {
  startHour: number;
  endHour: number;
}

interface SpringFestivalConfig {
  enabled: boolean;
  startDate: string;
  endDate: string;
  perTripSurcharge: number;
}

interface FareConfig {
  day: DayFareConfig;
  night: NightFareConfig;
  springFestival: SpringFestivalConfig;
  loveCardSubsidyAmount: number;
}

interface FormValues {
  day: DayFareConfig;
  night: NightFareConfig;
  springFestival: {
    enabled: boolean;
    dateRange: [Dayjs, Dayjs] | null;
    perTripSurcharge: number;
  };
  loveCardSubsidyAmount: number;
}

const Settings: React.FC = () => {
  const [loading, setLoading] = useState(false);
  const [fareLoading, setFareLoading] = useState(true);
  const [generalForm] = Form.useForm();
  const [fareForm] = Form.useForm<FormValues>();
  const [fareConfig, setFareConfig] = useState<FareConfig | null>(null);

  useEffect(() => {
    loadFareConfig();
  }, []);

  const loadFareConfig = async () => {
    try {
      setFareLoading(true);
      const response = await api.get('/config/fare');
      if (response.data.success) {
        const config: FareConfig = response.data.data;
        setFareConfig(config);
        fareForm.setFieldsValue({
          day: config.day,
          night: config.night,
          springFestival: {
            enabled: config.springFestival.enabled,
            dateRange: [
              dayjs(config.springFestival.startDate),
              dayjs(config.springFestival.endDate),
            ],
            perTripSurcharge: config.springFestival.perTripSurcharge,
          },
          loveCardSubsidyAmount: config.loveCardSubsidyAmount,
        });
      }
    } catch (error) {
      console.error('載入費率配置失敗:', error);
      message.error('載入費率配置失敗');
    } finally {
      setFareLoading(false);
    }
  };

  const initialGeneralSettings = {
    appName: '花蓮計程車',
    maintenanceMode: false,
    allowNewDrivers: true,
    allowNewPassengers: true,
    autoAssign: true,
  };

  const handleGeneralSave = async () => {
    try {
      await generalForm.validateFields();
      setLoading(true);
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

      if (!values.springFestival.dateRange || values.springFestival.dateRange.length !== 2) {
        message.error('請選擇春節起訖日期');
        setLoading(false);
        return;
      }

      const payload: FareConfig = {
        day: values.day,
        night: values.night,
        springFestival: {
          enabled: values.springFestival.enabled,
          startDate: values.springFestival.dateRange[0].format('YYYY-MM-DD'),
          endDate: values.springFestival.dateRange[1].format('YYYY-MM-DD'),
          perTripSurcharge: values.springFestival.perTripSurcharge,
        },
        loveCardSubsidyAmount: values.loveCardSubsidyAmount,
      };

      const response = await api.put('/config/fare', payload);

      if (response.data.success) {
        message.success('費率設定已儲存！Android App 重新開啟後會自動套用新費率。');
        setFareConfig(response.data.data);
      } else {
        message.error(response.data.error || '儲存失敗！');
      }
    } catch (error: any) {
      console.error('儲存費率失敗:', error);
      message.error(error.response?.data?.error || '儲存失敗！');
    } finally {
      setLoading(false);
    }
  };

  const formatDayPreview = (cfg: DayFareConfig) =>
    `日 1km：${cfg.basePrice} 元；日 2km：${cfg.basePrice + Math.ceil((2000 - cfg.baseDistanceMeters) / cfg.jumpDistanceMeters) * cfg.jumpPrice} 元`;

  const formatNightPreview = (cfg: NightFareConfig) =>
    `夜 1km：${cfg.basePrice + Math.ceil(Math.max(0, 1000 - cfg.baseDistanceMeters) / cfg.jumpDistanceMeters) * cfg.jumpPrice} 元；夜 2km：${cfg.basePrice + Math.ceil((2000 - cfg.baseDistanceMeters) / cfg.jumpDistanceMeters) * cfg.jumpPrice} 元（時段 ${cfg.startHour}:00–${cfg.endHour}:00）`;

  const tabItems = [
    {
      key: 'general',
      label: <span><SettingOutlined /> 一般設定</span>,
      children: (
        <Card>
          <Form form={generalForm} layout="vertical" initialValues={initialGeneralSettings}>
            <Title level={4}>系統設定</Title>
            <Row gutter={16}>
              <Col span={6}>
                <Form.Item label="維護模式" name="maintenanceMode" valuePropName="checked">
                  <Switch />
                </Form.Item>
              </Col>
              <Col span={6}>
                <Form.Item label="允許新司機註冊" name="allowNewDrivers" valuePropName="checked">
                  <Switch />
                </Form.Item>
              </Col>
              <Col span={6}>
                <Form.Item label="允許新乘客註冊" name="allowNewPassengers" valuePropName="checked">
                  <Switch />
                </Form.Item>
              </Col>
              <Col span={6}>
                <Form.Item label="自動派單" name="autoAssign" valuePropName="checked">
                  <Switch />
                </Form.Item>
              </Col>
            </Row>
            <Divider />
            <Form.Item>
              <Space>
                <Button type="primary" icon={<SaveOutlined />} onClick={handleGeneralSave} loading={loading}>
                  儲存設定
                </Button>
              </Space>
            </Form.Item>
          </Form>
        </Card>
      ),
    },
    {
      key: 'fare',
      label: <span><DollarOutlined /> 費率設定</span>,
      children: (
        <div>
          {fareLoading ? (
            <Card>
              <div style={{ textAlign: 'center', padding: '50px' }}>
                <Spin size="large" />
                <p style={{ marginTop: '16px' }}>載入費率配置中...</p>
              </div>
            </Card>
          ) : (
            <Form form={fareForm} layout="vertical">
              <Alert
                message="花蓮縣政府計程車費率公告"
                description="日費率與夜費率為兩組獨立的起跳/跳距設定（夜費率透過縮短起跳/跳距實現約 20% 加成）。春節期間全日套夜間費率，並每趟加收固定金額。低速計時欄位現階段已存儲於後端，GPS 計時整合為下階段功能。"
                type="info"
                showIcon
                style={{ marginBottom: '16px' }}
              />

              {/* 日費率 */}
              <Card title="日費率（白天費率）" style={{ marginBottom: '16px' }}>
                <Row gutter={16}>
                  <Col span={8}>
                    <Form.Item label="起跳價 (元)" name={['day', 'basePrice']} rules={[{ required: true }]} tooltip="起跳距離內的固定費用">
                      <InputNumber min={0} step={5} style={{ width: '100%' }} />
                    </Form.Item>
                  </Col>
                  <Col span={8}>
                    <Form.Item label="起跳距離 (公尺)" name={['day', 'baseDistanceMeters']} rules={[{ required: true }]}>
                      <InputNumber min={0} step={50} style={{ width: '100%' }} />
                    </Form.Item>
                  </Col>
                  <Col span={8}>
                    <Form.Item label="每跳價格 (元)" name={['day', 'jumpPrice']} rules={[{ required: true }]}>
                      <InputNumber min={0} step={5} style={{ width: '100%' }} />
                    </Form.Item>
                  </Col>
                  <Col span={8}>
                    <Form.Item label="每跳距離 (公尺)" name={['day', 'jumpDistanceMeters']} rules={[{ required: true }]}>
                      <InputNumber min={1} step={10} style={{ width: '100%' }} />
                    </Form.Item>
                  </Col>
                  <Col span={8}>
                    <Form.Item label="低速計時 (秒)" name={['day', 'slowTrafficSeconds']} rules={[{ required: true }]} tooltip="每滿幾秒加一次低速金額（駐車費）">
                      <InputNumber min={1} step={10} style={{ width: '100%' }} />
                    </Form.Item>
                  </Col>
                  <Col span={8}>
                    <Form.Item label="低速金額 (元)" name={['day', 'slowTrafficPrice']} rules={[{ required: true }]}>
                      <InputNumber min={0} step={5} style={{ width: '100%' }} />
                    </Form.Item>
                  </Col>
                </Row>
                {fareConfig && (
                  <Alert message={formatDayPreview(fareConfig.day)} type="success" showIcon style={{ marginTop: '8px' }} />
                )}
              </Card>

              {/* 夜費率 */}
              <Card title="夜費率（夜間費率）" style={{ marginBottom: '16px' }}>
                <Alert
                  message="夜費率的「起跳價」與「每跳價格」通常沿用日費率的 100/5 元，僅縮短起跳距離與每跳距離以實現夜間加成（花蓮縣府公告：起跳 834m / 每跳 192m）。"
                  type="warning"
                  style={{ marginBottom: '16px' }}
                />
                <Row gutter={16}>
                  <Col span={8}>
                    <Form.Item label="起跳價 (元)" name={['night', 'basePrice']} rules={[{ required: true }]}>
                      <InputNumber min={0} step={5} style={{ width: '100%' }} />
                    </Form.Item>
                  </Col>
                  <Col span={8}>
                    <Form.Item label="起跳距離 (公尺)" name={['night', 'baseDistanceMeters']} rules={[{ required: true }]}>
                      <InputNumber min={0} step={10} style={{ width: '100%' }} />
                    </Form.Item>
                  </Col>
                  <Col span={8}>
                    <Form.Item label="每跳價格 (元)" name={['night', 'jumpPrice']} rules={[{ required: true }]}>
                      <InputNumber min={0} step={5} style={{ width: '100%' }} />
                    </Form.Item>
                  </Col>
                  <Col span={8}>
                    <Form.Item label="每跳距離 (公尺)" name={['night', 'jumpDistanceMeters']} rules={[{ required: true }]}>
                      <InputNumber min={1} step={10} style={{ width: '100%' }} />
                    </Form.Item>
                  </Col>
                  <Col span={8}>
                    <Form.Item label="低速計時 (秒)" name={['night', 'slowTrafficSeconds']} rules={[{ required: true }]}>
                      <InputNumber min={1} step={10} style={{ width: '100%' }} />
                    </Form.Item>
                  </Col>
                  <Col span={8}>
                    <Form.Item label="低速金額 (元)" name={['night', 'slowTrafficPrice']} rules={[{ required: true }]}>
                      <InputNumber min={0} step={5} style={{ width: '100%' }} />
                    </Form.Item>
                  </Col>
                  <Col span={8}>
                    <Form.Item label="夜間開始時間 (時)" name={['night', 'startHour']} rules={[{ required: true }]} tooltip="0-23，例如 22 表示 22:00">
                      <InputNumber min={0} max={23} style={{ width: '100%' }} />
                    </Form.Item>
                  </Col>
                  <Col span={8}>
                    <Form.Item label="夜間結束時間 (時)" name={['night', 'endHour']} rules={[{ required: true }]} tooltip="0-23，例如 6 表示 06:00">
                      <InputNumber min={0} max={23} style={{ width: '100%' }} />
                    </Form.Item>
                  </Col>
                </Row>
                {fareConfig && (
                  <Alert message={formatNightPreview(fareConfig.night)} type="success" showIcon style={{ marginTop: '8px' }} />
                )}
              </Card>

              {/* 春節加成 */}
              <Card title="春節加成" style={{ marginBottom: '16px' }}>
                <Alert
                  message="春節期間全日套用夜間費率，並每趟加收固定金額。每年春節日期不同，需於春節前手動更新起訖日期。"
                  type="info"
                  style={{ marginBottom: '16px' }}
                />
                <Row gutter={16}>
                  <Col span={6}>
                    <Form.Item label="啟用春節加成" name={['springFestival', 'enabled']} valuePropName="checked">
                      <Switch />
                    </Form.Item>
                  </Col>
                  <Col span={12}>
                    <Form.Item label="春節起訖日期" name={['springFestival', 'dateRange']} rules={[{ required: true, message: '請選擇春節起訖日期' }]}>
                      <RangePicker style={{ width: '100%' }} format="YYYY-MM-DD" />
                    </Form.Item>
                  </Col>
                  <Col span={6}>
                    <Form.Item label="每趟加收 (元)" name={['springFestival', 'perTripSurcharge']} rules={[{ required: true }]}>
                      <InputNumber min={0} step={10} style={{ width: '100%' }} />
                    </Form.Item>
                  </Col>
                </Row>
              </Card>

              {/* 愛心卡 */}
              <Card title="愛心卡補貼" style={{ marginBottom: '16px' }}>
                <Row gutter={16}>
                  <Col span={8}>
                    <Form.Item label="每趟補貼金額 (元)" name="loveCardSubsidyAmount" rules={[{ required: true }]} tooltip="持愛心卡的乘客每趟由政府補貼的金額">
                      <InputNumber min={0} step={1} style={{ width: '100%' }} />
                    </Form.Item>
                  </Col>
                </Row>
              </Card>

              <Divider />

              <Form.Item>
                <Space>
                  <Button type="primary" icon={<SaveOutlined />} onClick={handleFareSave} loading={loading}>
                    儲存費率
                  </Button>
                  <Button icon={<ReloadOutlined />} onClick={loadFareConfig}>
                    重新載入
                  </Button>
                </Space>
              </Form.Item>
            </Form>
          )}
        </div>
      ),
    },
    {
      key: 'notification',
      label: <span><BellOutlined /> 通知設定</span>,
      children: (
        <Card>
          <Alert message="通知設定功能開發中" type="info" />
        </Card>
      ),
    },
    {
      key: 'email',
      label: <span><MailOutlined /> 郵件設定</span>,
      children: (
        <Card>
          <Alert message="郵件設定功能開發中" type="info" />
        </Card>
      ),
    },
  ];

  return (
    <div style={{ padding: '24px' }}>
      <Title level={2}>系統設定</Title>
      <Paragraph>管理應用程式的各項設定，包括費率、通知、郵件等。</Paragraph>
      <Tabs defaultActiveKey="fare" items={tabItems} />
    </div>
  );
};

export default Settings;
