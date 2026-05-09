/**
 * 分潤規則管理頁
 *
 * 規則類型：
 *   - FIXED_PER_ORDER: 每單固定金額（元），例：每單 10 元給招募人
 *   - PERCENTAGE: 車資的百分比，例：5% 給車隊
 *
 * 改 rule 不影響歷史 BillingSnapshot（distribution 已寫死）。
 */
import React, { useEffect, useState } from 'react';
import {
  Table, Button, Modal, Form, Input, Tag, Space, Popconfirm, Select,
  App as AntdApp, Typography, Switch, InputNumber, DatePicker,
} from 'antd';
import { PlusOutlined, EditOutlined, DeleteOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import { commissionRuleAPI, partnerAPI, type CommissionRule, type Partner } from '../services/api';

const { Title } = Typography;

const RULE_TYPE_LABEL: Record<string, string> = {
  FIXED_PER_ORDER: '每單固定金額',
  PERCENTAGE: '百分比',
};

const PARTNER_TYPE_COLOR: Record<string, string> = {
  FLEET: 'blue',
  BRAND: 'green',
  RECRUITER: 'orange',
};

const CommissionRules: React.FC = () => {
  const { message } = AntdApp.useApp();
  const [list, setList] = useState<CommissionRule[]>([]);
  const [partners, setPartners] = useState<Partner[]>([]);
  const [loading, setLoading] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<CommissionRule | null>(null);
  const [form] = Form.useForm();
  const [ruleType, setRuleType] = useState<'FIXED_PER_ORDER' | 'PERCENTAGE'>('PERCENTAGE');

  const fetchData = async () => {
    setLoading(true);
    try {
      const [rulesRes, partnersRes] = await Promise.all([
        commissionRuleAPI.list(),
        partnerAPI.list(undefined, true),
      ]);
      setList(rulesRes.data.data || []);
      setPartners(partnersRes.data.data || []);
    } catch (e: any) {
      message.error('載入失敗：' + e.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { fetchData(); }, []);

  const openCreate = () => {
    setEditing(null);
    form.resetFields();
    form.setFieldsValue({
      rule_type: 'PERCENTAGE',
      amount: 5,
      effective_from: dayjs(),
      is_active: true,
    });
    setRuleType('PERCENTAGE');
    setModalOpen(true);
  };

  const openEdit = (r: CommissionRule) => {
    setEditing(r);
    form.setFieldsValue({
      ...r,
      effective_from: r.effective_from ? dayjs(r.effective_from) : null,
      effective_to: r.effective_to ? dayjs(r.effective_to) : null,
    });
    setRuleType(r.rule_type);
    setModalOpen(true);
  };

  const handleSubmit = async () => {
    try {
      const values = await form.validateFields();
      const payload = {
        ...values,
        effective_from: values.effective_from ? values.effective_from.toISOString() : undefined,
        effective_to: values.effective_to ? values.effective_to.toISOString() : null,
      };
      if (editing) {
        await commissionRuleAPI.update(editing.rule_id, payload);
        message.success('已更新');
      } else {
        await commissionRuleAPI.create(payload);
        message.success('已建立');
      }
      setModalOpen(false);
      fetchData();
    } catch (e: any) {
      message.error(e.response?.data?.error || e.message);
    }
  };

  const handleDelete = async (id: number) => {
    try {
      await commissionRuleAPI.delete(id);
      message.success('已停用');
      fetchData();
    } catch (e: any) {
      message.error(e.response?.data?.error || e.message);
    }
  };

  const columns = [
    {
      title: '對象',
      dataIndex: 'partner_name',
      render: (name: string, row: CommissionRule) => (
        <Space>
          {row.partner_type && (
            <Tag color={PARTNER_TYPE_COLOR[row.partner_type]}>{row.partner_type}</Tag>
          )}
          {name}
        </Space>
      ),
    },
    {
      title: '類型',
      dataIndex: 'rule_type',
      width: 130,
      render: (v: string) => RULE_TYPE_LABEL[v] || v,
    },
    {
      title: '金額',
      dataIndex: 'amount',
      width: 100,
      render: (v: number, row: CommissionRule) => row.rule_type === 'PERCENTAGE' ? `${v}%` : `$${v}`,
    },
    {
      title: '生效',
      dataIndex: 'effective_from',
      width: 110,
      render: (v: string) => v ? dayjs(v).format('YYYY-MM-DD') : '-',
    },
    {
      title: '結束',
      dataIndex: 'effective_to',
      width: 110,
      render: (v: string) => v ? dayjs(v).format('YYYY-MM-DD') : '永久',
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
      render: (_: any, row: CommissionRule) => (
        <Space>
          <Button size="small" icon={<EditOutlined />} onClick={() => openEdit(row)}>編輯</Button>
          {row.is_active && (
            <Popconfirm title="確認停用？" onConfirm={() => handleDelete(row.rule_id)}>
              <Button size="small" danger icon={<DeleteOutlined />}>停用</Button>
            </Popconfirm>
          )}
        </Space>
      ),
    },
  ];

  return (
    <div style={{ padding: 24 }}>
      <Title level={3}>分潤規則管理</Title>
      <Space style={{ marginBottom: 16 }}>
        <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>新增規則</Button>
      </Space>
      <Table
        rowKey="rule_id"
        loading={loading}
        dataSource={list}
        columns={columns}
        pagination={false}
      />

      <Modal
        title={editing ? '編輯規則' : '新增分潤規則'}
        open={modalOpen}
        onCancel={() => setModalOpen(false)}
        onOk={handleSubmit}
        okText="儲存"
        cancelText="取消"
        destroyOnHidden
      >
        <Form form={form} layout="vertical">
          <Form.Item label="合作對象" name="partner_id" rules={[{ required: true }]}>
            <Select
              placeholder="選擇 partner"
              disabled={!!editing}
              options={partners.map(p => ({
                value: p.partner_id,
                label: `[${p.type}] ${p.name}`,
              }))}
            />
          </Form.Item>
          <Form.Item label="規則類型" name="rule_type" rules={[{ required: true }]}>
            <Select
              onChange={(v) => setRuleType(v)}
              options={[
                { value: 'PERCENTAGE', label: '百分比（車資的 X%）' },
                { value: 'FIXED_PER_ORDER', label: '每單固定金額（X 元）' },
              ]}
            />
          </Form.Item>
          <Form.Item
            label={ruleType === 'PERCENTAGE' ? '百分比 (0-100)' : '每單金額（元）'}
            name="amount"
            rules={[
              { required: true, message: '必填' },
              { type: 'number', min: 0, message: '不可為負' },
              { type: 'number', max: ruleType === 'PERCENTAGE' ? 100 : 99999 },
            ]}
          >
            <InputNumber style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item label="生效起" name="effective_from">
            <DatePicker showTime style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item label="生效迄（留空 = 永久）" name="effective_to">
            <DatePicker showTime style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item label="備註" name="notes">
            <Input.TextArea rows={2} placeholder="（選填）" />
          </Form.Item>
          <Form.Item label="啟用" name="is_active" valuePropName="checked">
            <Switch />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
};

export default CommissionRules;
