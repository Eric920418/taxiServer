/**
 * Partners 管理頁 — 合作對象 CRUD
 * 3 個 tab：車隊（FLEET）/ 品牌（BRAND）/ 招募人（RECRUITER）
 *
 * Partner 主要用途：統計、結算、合作管理（**不是派單條件**）
 */
import React, { useEffect, useState } from 'react';
import {
  Table, Button, Modal, Form, Input, Tabs, Tag, Space, Popconfirm,
  App as AntdApp, Typography, Switch, InputNumber
} from 'antd';
import { PlusOutlined, EditOutlined, DeleteOutlined } from '@ant-design/icons';
import { partnerAPI, type Partner } from '../services/api';
import HealthBanner from '../components/HealthBanner';

const { Title } = Typography;

const TYPE_LABELS: Record<string, string> = {
  FLEET: '車隊',
  BRAND: '品牌',
  RECRUITER: '招募人',
};

const TYPE_COLORS: Record<string, string> = {
  FLEET: 'blue',
  BRAND: 'green',
  RECRUITER: 'orange',
};

// 自動生成 partner_id：例 fleet_a3b9k2x7 / brand_x7y8z9q1
// 規則：type 小寫 + 底線 + 8 字 base36 隨機（總長 ≤ 14 字，符合 pattern ^[A-Za-z0-9_-]{1,50}$）
function generatePartnerId(type: 'FLEET' | 'BRAND' | 'RECRUITER'): string {
  const rand = Math.random().toString(36).slice(2, 10).padEnd(8, '0');
  return `${type.toLowerCase()}_${rand}`;
}


const Partners: React.FC = () => {
  const { message } = AntdApp.useApp();
  const [activeType, setActiveType] = useState<'FLEET' | 'BRAND' | 'RECRUITER'>('FLEET');
  const [list, setList] = useState<Partner[]>([]);
  const [loading, setLoading] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<Partner | null>(null);
  const [form] = Form.useForm();

  const fetchList = async () => {
    setLoading(true);
    try {
      const res = await partnerAPI.list(activeType, false); // 含已停用
      setList(res.data.data || []);
    } catch (e: any) {
      message.error('載入失敗：' + e.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { fetchList(); }, [activeType]);

  const openCreate = () => {
    setEditing(null);
    form.resetFields();
    form.setFieldsValue({
      partner_id: generatePartnerId(activeType),
      type: activeType,
      is_active: true,
      default_order_discount_amount: 0,
    });
    setModalOpen(true);
  };

  const openEdit = (p: Partner) => {
    setEditing(p);
    form.setFieldsValue(p);
    setModalOpen(true);
  };

  const handleSubmit = async () => {
    try {
      const values = await form.validateFields();
      if (editing) {
        await partnerAPI.update(editing.partner_id, values);
        message.success('已更新');
      } else {
        await partnerAPI.create(values);
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
      await partnerAPI.delete(id);
      message.success('已停用');
      fetchList();
    } catch (e: any) {
      message.error(e.response?.data?.error || e.message);
    }
  };

  const columns = [
    { title: 'ID', dataIndex: 'partner_id', width: 150 },
    { title: '名稱', dataIndex: 'name' },
    { title: '聯絡人', dataIndex: 'contact_name', width: 100 },
    { title: '電話', dataIndex: 'contact_phone', width: 130 },
    {
      title: '狀態',
      dataIndex: 'is_active',
      width: 80,
      render: (v: boolean) => v ? <Tag color="green">啟用</Tag> : <Tag>停用</Tag>,
    },
    {
      title: '操作',
      width: 160,
      render: (_: any, row: Partner) => (
        <Space>
          <Button size="small" icon={<EditOutlined />} onClick={() => openEdit(row)}>編輯</Button>
          {row.is_active && (
            <Popconfirm title="確認停用？" onConfirm={() => handleDelete(row.partner_id)}>
              <Button size="small" danger icon={<DeleteOutlined />}>停用</Button>
            </Popconfirm>
          )}
        </Space>
      ),
    },
  ];

  return (
    <div style={{ padding: 24 }}>
      <HealthBanner currentPagePath="/admin/partners" />
      <Title level={3}>合作對象管理</Title>
      <Tabs
        activeKey={activeType}
        onChange={(k) => setActiveType(k as any)}
        items={[
          { key: 'FLEET', label: <Tag color="blue">車隊</Tag> },
          { key: 'BRAND', label: <Tag color="green">品牌</Tag> },
          { key: 'RECRUITER', label: <Tag color="orange">招募人</Tag> },
        ]}
      />

      <Space style={{ marginBottom: 16 }}>
        <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
          新增{TYPE_LABELS[activeType]}
        </Button>
      </Space>

      <Table
        rowKey="partner_id"
        loading={loading}
        dataSource={list}
        columns={columns}
        pagination={false}
      />

      <Modal
        title={editing ? `編輯${TYPE_LABELS[activeType]}` : `新增${TYPE_LABELS[activeType]}`}
        open={modalOpen}
        onCancel={() => setModalOpen(false)}
        onOk={handleSubmit}
        okText="儲存"
        cancelText="取消"
        destroyOnHidden
      >
        <Form form={form} layout="vertical">
          {/* partner_id 永遠 mount，只切換 hidden / label — 避免 conditional render 觸發 setFieldsValue 同步 bug */}
          <Form.Item
            name="partner_id"
            label={editing ? 'ID（系統自動生成）' : undefined}
            hidden={!editing}
          >
            <Input disabled />
          </Form.Item>
          <Form.Item label="類型" name="type" rules={[{ required: true }]}>
            <Input disabled />
          </Form.Item>
          <Form.Item label="名稱" name="name" rules={[{ required: true, max: 100 }]}>
            <Input placeholder="例：大豐車隊" />
          </Form.Item>
          <Form.Item label="聯絡人" name="contact_name">
            <Input placeholder="（選填）" />
          </Form.Item>
          <Form.Item label="聯絡電話" name="contact_phone">
            <Input placeholder="（選填）" />
          </Form.Item>
          <Form.Item
            label="預設訂單折扣金額"
            name="default_order_discount_amount"
            tooltip="此 partner 帶來的訂單預設給司機多少折扣（NT$ 元，4 段制 0/10/20/30/40）。LINE 官方/電話來源若無客人指定則套用此值"
          >
            <InputNumber min={0} max={40} step={10} style={{ width: '100%' }} addonAfter="元" />
          </Form.Item>
          <Form.Item
            label="備註"
            name="notes"
            tooltip="會出現在月結報表中，給合作代理人/合作車隊看的說明（例：30 元折扣車隊／2026 Q2 合作）"
          >
            <Input.TextArea rows={2} placeholder="（選填）合作條件、報表備註等" maxLength={500} />
          </Form.Item>
          <Form.Item label="啟用" name="is_active" valuePropName="checked">
            <Switch />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
};

export default Partners;
