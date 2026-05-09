/**
 * Partners 管理頁 — 合作對象 CRUD
 * 3 個 tab：車隊（FLEET）/ 品牌（BRAND）/ 招募人（RECRUITER）
 *
 * Partner 主要用途：統計、結算、合作管理（**不是派單條件**）
 */
import React, { useEffect, useState } from 'react';
import {
  Table, Button, Modal, Form, Input, Tabs, Tag, Space, Popconfirm,
  App as AntdApp, Typography, Switch,
} from 'antd';
import { PlusOutlined, EditOutlined, DeleteOutlined } from '@ant-design/icons';
import { partnerAPI, type Partner } from '../services/api';

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
    form.setFieldsValue({ type: activeType, is_active: true });
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
          <Form.Item
            label="ID（建立後不可改）"
            name="partner_id"
            rules={[
              { required: true, message: '必填' },
              { pattern: /^[A-Za-z0-9_-]{1,50}$/, message: '只能含英數、底線、連字號' },
            ]}
          >
            <Input disabled={!!editing} placeholder="例：dafeng / brand_a / recruiter_eric" />
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
          <Form.Item label="啟用" name="is_active" valuePropName="checked">
            <Switch />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
};

export default Partners;
