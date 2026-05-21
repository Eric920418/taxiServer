/**
 * QueueZones 排班區管理頁
 *
 * 圓形排班區：地圖選圓心 + radius slider 50-2000m
 * 顯示即時 active_drivers 數量
 */
import React, { useEffect, useState } from 'react';
import {
  Table, Button, Modal, Form, Input, InputNumber, Tag, Space, Popconfirm, Switch,
  App as AntdApp, Typography, Slider, Row, Col, Select,
} from 'antd';
import { PlusOutlined, EditOutlined, DeleteOutlined, EnvironmentOutlined } from '@ant-design/icons';
import GoogleMapsPicker, { type GoogleMapsPickerChange } from '../components/GoogleMapsPicker';
import HealthBanner from '../components/HealthBanner';
import { queueZoneAPI, type QueueZone } from '../services/api';

const { Title, Text } = Typography;


// 自動生成 zone_id：例 zone_a3b9k2x7
// 規則：zone_ + 8 字 base36 隨機（符合 pattern ^[A-Za-z0-9_-]{1,50}$）
function generateZoneId(): string {
  const rand = Math.random().toString(36).slice(2, 10).padEnd(8, '0');
  return `zone_${rand}`;
}

const QueueZones: React.FC = () => {
  const { message } = AntdApp.useApp();
  const [list, setList] = useState<QueueZone[]>([]);
  const [loading, setLoading] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<QueueZone | null>(null);
  const [form] = Form.useForm();
  const [formLat, setFormLat] = useState<number | null>(null);
  const [formLng, setFormLng] = useState<number | null>(null);
  const [radius, setRadius] = useState<number>(1000);

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
    form.setFieldsValue({
      zone_id: generateZoneId(),
      radius_meters: 1000,
      is_active: true,
      dispatch_mode: 'PARALLEL',  // 預設 PARALLEL（批次推播，向下相容）
    });
    setFormLat(null);
    setFormLng(null);
    setRadius(1000);
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
    // 名稱建議：搜地點時 Google 給的 name 可作 zone 名
    if (change.name && !form.getFieldValue('name')) {
      form.setFieldsValue({ name: change.name });
    }
  };

  const handleSubmit = async () => {
    // 經緯度走 useState (formLat/formLng) 而非 Form store
    // antd hidden InputNumber + setFieldsValue 同步有 bug
    if (formLat == null || formLng == null || isNaN(formLat) || isNaN(formLng)) {
      message.error('請先在下方地圖點擊或搜尋地點以自動填入座標');
      return;
    }
    try {
      const values = await form.validateFields();
      const payload = { ...values, center_lat: formLat, center_lng: formLng };
      if (editing) {
        await queueZoneAPI.update(editing.zone_id, payload);
        message.success('已更新');
      } else {
        await queueZoneAPI.create(payload);
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
      title: '派單模式',
      dataIndex: 'dispatch_mode',
      width: 110,
      render: (v: string) =>
        v === 'SERIAL'
          ? <Tag color="purple">嚴格順位</Tag>
          : <Tag color="blue">批次推播</Tag>,
    },
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
      <HealthBanner currentPagePath="/admin/queue-zones" />
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
          {/* zone_id 永遠 mount，避免 conditional render 觸發 antd setFieldsValue 同步 bug */}
          <Row gutter={16}>
            <Col span={editing ? 10 : 0} style={{ display: editing ? undefined : 'none' }}>
              <Form.Item
                name="zone_id"
                label={editing ? 'ID（系統自動生成）' : undefined}
                hidden={!editing}
              >
                <Input disabled />
              </Form.Item>
            </Col>
            <Col span={editing ? 14 : 24}>
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
            <Slider min={50} max={2000} step={50} marks={{ 50: '50m', 500: '500m', 1000: '1km', 1500: '1.5km', 2000: '2km' }}
              onChange={(v) => setRadius(v as number)}
            />
          </Form.Item>



          <Form.Item
            label="派單模式"
            name="dispatch_mode"
            tooltip="嚴格順位：訂單一次只推給 #1 司機，15s 沒接才推 #2（公平排班）。批次推播：訂單同時推給所有 queue 司機，先按先贏（原本行為）。"
            rules={[{ required: true }]}
          >
            <Select
              options={[
                { value: 'PARALLEL', label: '批次推播（先按先贏，原本行為）' },
                { value: 'SERIAL', label: '嚴格順位（一次一人 15s，公平排班）' },
              ]}
            />
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
