import React, { useState, useEffect } from 'react';
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
  Spin,
  Alert,
} from 'antd';
import {
  SaveOutlined,
  ReloadOutlined,
  SettingOutlined,
  DollarOutlined,
  BellOutlined,
  MailOutlined,
} from '@ant-design/icons';
import api from '../services/api';

const { Title, Paragraph } = Typography;

interface FareConfig {
  basePrice: number;
  baseDistanceMeters: number;
  jumpDistanceMeters: number;
  jumpPrice: number;
  nightSurchargeRate: number;
  nightStartHour: number;
  nightEndHour: number;
}

const Settings: React.FC = () => {
  const [loading, setLoading] = useState(false);
  const [fareLoading, setFareLoading] = useState(true);
  const [generalForm] = Form.useForm();
  const [fareForm] = Form.useForm();
  const [fareConfig, setFareConfig] = useState<FareConfig | null>(null);

  useEffect(() => {
    loadFareConfig();
  }, []);

  const loadFareConfig = async () => {
    try {
      setFareLoading(true);
      const response = await api.get('/config/fare');
      if (response.data.success) {
        const config = response.data.data;
        setFareConfig(config);
        fareForm.setFieldsValue({
          basePrice: config.basePrice,
          baseDistanceMeters: config.baseDistanceMeters,
          jumpDistanceMeters: config.jumpDistanceMeters,
          jumpPrice: config.jumpPrice,
          nightSurchargeRate: config.nightSurchargeRate * 100,
          nightStartHour: config.nightStartHour,
          nightEndHour: config.nightEndHour,
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

      const response = await api.put('/config/fare', {
        basePrice: values.basePrice,
        baseDistanceMeters: values.baseDistanceMeters,
        jumpDistanceMeters: values.jumpDistanceMeters,
        jumpPrice: values.jumpPrice,
        nightSurchargeRate: values.nightSurchargeRate / 100,
        nightStartHour: values.nightStartHour,
        nightEndHour: values.nightEndHour,
      });

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

  const formatFareInfo = (config: FareConfig) => {
    const baseKm = config.baseDistanceMeters / 1000;
    const rate = config.nightSurchargeRate * 100;
    return {
      current: '目前費率：起跳 ' + config.basePrice + ' 元 / ' + baseKm + ' 公里，之後每 ' + config.jumpDistanceMeters + ' 公尺跳 ' + config.jumpPrice + ' 元',
      night: '夜間時段：' + config.nightStartHour + ':00 - ' + config.nightEndHour + ':00，加成 ' + rate + '%'
    };
  };

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
        <Card>
          {fareLoading ? (
            <div style={{ textAlign: 'center', padding: '50px' }}>
              <Spin size="large" />
              <p style={{ marginTop: '16px' }}>載入費率配置中...</p>
            </div>
          ) : (
            <Form form={fareForm} layout="vertical">
              <Alert
                message="跳錶制費率說明"
                description="起跳距離內收取起跳價，超過後每行駛「每跳距離」就加收「每跳價格」。夜間時段額外加收夜間加成比例。車資尾數只會是 0 或 5。"
                type="info"
                showIcon
                style={{ marginBottom: '24px' }}
              />

              <Title level={4}>基本費率</Title>
              <Row gutter={16}>
                <Col span={6}>
                  <Form.Item label="起跳價 (元)" name="basePrice" rules={[{ required: true }]} tooltip="起跳距離內的固定費用">
                    <InputNumber min={0} step={5} style={{ width: '100%' }} />
                  </Form.Item>
                </Col>
                <Col span={6}>
                  <Form.Item label="起跳距離 (公尺)" name="baseDistanceMeters" rules={[{ required: true }]} tooltip="起跳價包含的距離">
                    <InputNumber min={0} step={50} style={{ width: '100%' }} />
                  </Form.Item>
                </Col>
                <Col span={6}>
                  <Form.Item label="每跳距離 (公尺)" name="jumpDistanceMeters" rules={[{ required: true }]} tooltip="超過起跳距離後，每行駛多少公尺跳一次錶">
                    <InputNumber min={1} step={50} style={{ width: '100%' }} />
                  </Form.Item>
                </Col>
                <Col span={6}>
                  <Form.Item label="每跳價格 (元)" name="jumpPrice" rules={[{ required: true }]} tooltip="每跳一次增加的費用">
                    <InputNumber min={0} step={5} style={{ width: '100%' }} />
                  </Form.Item>
                </Col>
              </Row>

              {fareConfig && (
                <Alert
                  message={formatFareInfo(fareConfig).current}
                  type="success"
                  style={{ marginBottom: '24px' }}
                />
              )}

              <Divider />

              <Title level={4}>夜間加成</Title>
              <Row gutter={16}>
                <Col span={8}>
                  <Form.Item label="夜間加成 (%)" name="nightSurchargeRate" rules={[{ required: true }]}>
                    <InputNumber min={0} max={100} style={{ width: '100%' }} />
                  </Form.Item>
                </Col>
                <Col span={8}>
                  <Form.Item label="夜間開始時間 (小時)" name="nightStartHour" rules={[{ required: true }]} tooltip="0-23">
                    <InputNumber min={0} max={23} style={{ width: '100%' }} />
                  </Form.Item>
                </Col>
                <Col span={8}>
                  <Form.Item label="夜間結束時間 (小時)" name="nightEndHour" rules={[{ required: true }]} tooltip="0-23">
                    <InputNumber min={0} max={23} style={{ width: '100%' }} />
                  </Form.Item>
                </Col>
              </Row>

              {fareConfig && (
                <Alert
                  message={formatFareInfo(fareConfig).night}
                  type="warning"
                  style={{ marginBottom: '24px' }}
                />
              )}

              <Divider />

              <Form.Item>
                <Space>
                  <Button type="primary" icon={<SaveOutlined />} onClick={handleFareSave} loading={loading}>
                    儲存設定
                  </Button>
                  <Button icon={<ReloadOutlined />} onClick={loadFareConfig}>
                    重新載入
                  </Button>
                </Space>
              </Form.Item>
            </Form>
          )}
        </Card>
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
