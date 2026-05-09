/**
 * QueueZones 排班區管理頁
 *
 * 圓形排班區：地圖選圓心 + radius slider 50-1000m
 * 顯示即時 active_drivers 數量
 */
import React, { useEffect, useState } from 'react';
import {
  Table, Button, Modal, Form, Input, InputNumber, Tag, Space, Popconfirm, Switch,
  App as AntdApp, Typography, Slider, Row, Col,
} from 'antd';
import { PlusOutlined, EditOutlined, DeleteOutlined, EnvironmentOutlined } from '@ant-design/icons';
import GoogleMapsPicker, { type GoogleMapsPickerChange } from '../components/GoogleMapsPicker';
import { queueZoneAPI, type QueueZone } from '../services/api';

const { Title, Text } = Typography;

const QueueZones: React.FC = () => {
  const { message } = AntdApp.useApp();
  const [list, setList] = useState<QueueZone[]>([]);
  const [loading, setLoading] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<QueueZone | null>(null);
  const [form] = Form.useForm();
  const [formLat, setFormLat] = useState<number | null>(null);
  const [formLng, setFormLng] = useState<number | null>(null);
  const [radius, setRadius] = useState<number>(300);

  const fetchList = async () => {
    setLoading(true);
    try {
      const res = await queueZoneAPI.list(true); // 含已停用
      setList(res.data.data || []);
    } catch (e: any) {
      message.error('載入失敗：' + e.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { fetchList(); }, []);

  const openCreate = () => {
    setEditing(null);
    form.resetFields();
    form.setFieldsValue({ radius_meters: 300, is_active: true });
    setFormLat(null);
    setFormLng(null);
    setRadius(300);
    setModalOpen(true);
  };

  const openEdit = (z: QueueZone) => {
    setEditing(z);
    const lat = parseFloat(z.center_lat as string);
    const lng = parseFloat(z.center_lng as string);
    form.setFieldsValue({
      ...z,
      center_lat: lat,
      center_lng: lng,
    });
    setFormLat(lat);
    setFormLng(lng);
    setRadius(z.radius_meters);
    setModalOpen(true);
  };

  const handleMapChange = (change: GoogleMapsPickerChange) => {
    setFormLat(change.lat);
    setFormLng(change.lng);
    form.setFieldsValue({ center_lat: change.lat, center_lng: change.lng });
    // 名稱建議：搜地點時 Google 給的 name 可作 zone 名
    if (change.name && !form.getFieldValue('name')) {
      form.setFieldsValue({ name: change.name });
    }
  };

  const handleSubmit = async () => {
    try {
      const values = await form.validateFields();
      if (editing) {
        await queueZoneAPI.update(editing.zone_id, values);
        message.success('已更新');
      } else {
        await queueZoneAPI.create(values);
        message.success('已建立');
      }
      setModalOpen(false);
      fetchList();
    } catch (e: any) {
      message.error(e.response?.data?.error || e.message);
    }
  };

  const handleDelete = async (id: string) => {
    try {
      await queueZoneAPI.delete(id);
      message.success('已停用，相關 ACTIVE 排班已踢出');
      fetchList();
    } catch (e: any) {
      message.error(e.response?.data?.error || e.message);
    }
  };

  const columns = [
    { title: 'ID', dataIndex: 'zone_id', width: 130 },
    { title: '名稱', dataIndex: 'name', width: 120 },
    {
      title: '中心座標',
      width: 200,
      render: (_: any, row: QueueZone) =>
        `${parseFloat(row.center_lat as string).toFixed(5)}, ${parseFloat(row.center_lng as string).toFixed(5)}`,
    },
    { title: '半徑', dataIndex: 'radius_meters', width: 90, render: (v: number) => `${v} m` },
    {
      title: '當前排班',
      dataIndex: 'active_drivers',
      width: 100,
      render: (v: number) => v > 0 ? <Tag color="orange">{v} 人</Tag> : <Text type="secondary">—</Text>,
    },
    {
      title: '狀態',
      dataIndex: 'is_active',
      width: 80,
      render: (v: boolean) => v ? <Tag color="green">啟用</Tag> : <Tag>停用</Tag>,
    },
    {
      title: '操作',
      width: 160,
      render: (_: any, row: QueueZone) => (
        <Space>
          <Button size="small" icon={<EditOutlined />} onClick={() => openEdit(row)}>編輯</Button>
          {row.is_active && (
            <Popconfirm title="確認停用？此 zone 內所有排班會被踢出" onConfirm={() => handleDelete(row.zone_id)}>
              <Button size="small" danger icon={<DeleteOutlined />}>停用</Button>
            </Popconfirm>
          )}
        </Space>
      ),
    },
  ];

  return (
    <div style={{ padding: 24 }}>
      <Title level={3}><EnvironmentOutlined /> 排班區管理</Title>
      <Text type="secondary">
        司機可加入排班區。當該區內有訂單時，系統優先派給排班司機（P3 上線後生效）。
      </Text>
      <div style={{ marginTop: 16, marginBottom: 16 }}>
        <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>新增排班區</Button>
      </div>
      <Table
        rowKey="zone_id"
        loading={loading}
        dataSource={list}
        columns={columns}
        pagination={false}
      />

      <Modal
        title={editing ? '編輯排班區' : '新增排班區'}
        open={modalOpen}
        onCancel={() => setModalOpen(false)}
        onOk={handleSubmit}
        okText="儲存"
        cancelText="取消"
        width={800}
        destroyOnHidden
      >
        <Form form={form} layout="vertical">
          <Row gutter={16}>
            <Col span={10}>
              <Form.Item
                label="ID（建立後不可改）"
                name="zone_id"
                rules={[
                  { required: true, message: '必填' },
                  { pattern: /^[A-Za-z0-9_-]{1,50}$/, message: '只能含英數、底線、連字號' },
                ]}
              >
                <Input disabled={!!editing} placeholder="例：front_station / tzuchi" />
              </Form.Item>
            </Col>
            <Col span={14}>
              <Form.Item label="名稱（顯示給司機）" name="name" rules={[{ required: true, max: 50 }]}>
                <Input placeholder="例：前站 / 慈濟 / 美崙" />
              </Form.Item>
            </Col>
          </Row>

          <Text type="secondary" style={{ display: 'block', marginBottom: 8 }}>
            🗺 在地圖上選圓心位置（中心點）。司機 GPS 必須在此圓內才能加入排班。
          </Text>
          <GoogleMapsPicker
            lat={formLat}
            lng={formLng}
            onChange={handleMapChange}
            height={360}
          />

          <Form.Item
            label={<span>半徑：<b>{radius}</b> 公尺</span>}
            name="radius_meters"
            rules={[{ required: true }]}
            style={{ marginTop: 16 }}
          >
            <Slider min={50} max={1000} step={50} marks={{ 50: '50m', 300: '300m', 500: '500m', 1000: '1km' }}
              onChange={(v) => setRadius(v as number)}
            />
          </Form.Item>

          <Form.Item name="center_lat" hidden rules={[{ required: true, message: '請從地圖選位置' }]}>
            <InputNumber />
          </Form.Item>
          <Form.Item name="center_lng" hidden rules={[{ required: true, message: '請從地圖選位置' }]}>
            <InputNumber />
          </Form.Item>

          <Form.Item label="啟用" name="is_active" valuePropName="checked">
            <Switch />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
};

export default QueueZones;
