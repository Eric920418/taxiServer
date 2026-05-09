/**
 * Billing 結算對帳報表
 *
 * 三 tab：
 *   1. 平台總覽 — 跨 partner 統計
 *   2. 合作對象月報 — 選 partner + 月份 → 看每位司機
 *   3. 司機月結 — 選司機 + 月份 → 看每筆訂單明細
 *
 * 對帳警示：Σ司機單 != Σ snapshot 時紅字
 * 匯出：CSV（前端產生）
 */
import React, { useEffect, useState } from 'react';
import {
  Tabs, Card, Row, Col, Statistic, Table, Select, DatePicker, Button, Space, Tag, Alert,
  App as AntdApp, Typography,
} from 'antd';
import { DownloadOutlined, ReloadOutlined } from '@ant-design/icons';
import dayjs, { Dayjs } from 'dayjs';
import {
  billingAPI, partnerAPI, type Partner,
  type BillingPartnerMonthlyResponse, type BillingDriverMonthlyResponse,
  type BillingPlatformMonthlyResponse,
  driverAPI,
} from '../services/api';

const { Title } = Typography;

const PARTNER_TYPE_COLOR: Record<string, string> = {
  FLEET: 'blue',
  BRAND: 'green',
  RECRUITER: 'orange',
  PLATFORM: 'purple',
};

function downloadCSV(filename: string, rows: Array<Record<string, any>>) {
  if (rows.length === 0) return;
  const headers = Object.keys(rows[0]);
  const csv = [
    headers.join(','),
    ...rows.map(r => headers.map(h => {
      const v = r[h];
      if (v == null) return '';
      const s = typeof v === 'string' ? v.replace(/"/g, '""') : String(v);
      return /[",\n]/.test(s) ? `"${s}"` : s;
    }).join(',')),
  ].join('\n');

  // BOM for Excel UTF-8
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

const Billing: React.FC = () => {
  const { message } = AntdApp.useApp();
  const [activeTab, setActiveTab] = useState('platform');
  const [month, setMonth] = useState<Dayjs>(dayjs());

  return (
    <div style={{ padding: 24 }}>
      <Title level={3}>結算對帳報表</Title>
      <Space style={{ marginBottom: 16 }}>
        <span>月份：</span>
        <DatePicker.MonthPicker
          value={month}
          onChange={(v) => v && setMonth(v)}
          format="YYYY-MM"
          allowClear={false}
        />
      </Space>

      <Tabs
        activeKey={activeTab}
        onChange={setActiveTab}
        items={[
          {
            key: 'platform',
            label: '平台總覽',
            children: <PlatformReport month={month} />,
          },
          {
            key: 'partner',
            label: '合作對象月報',
            children: <PartnerReport month={month} />,
          },
          {
            key: 'driver',
            label: '司機月結',
            children: <DriverReport month={month} />,
          },
        ]}
      />
    </div>
  );
};

// ============================================================
// Tab 1: 平台總覽
// ============================================================
const PlatformReport: React.FC<{ month: Dayjs }> = ({ month }) => {
  const { message } = AntdApp.useApp();
  const [data, setData] = useState<BillingPlatformMonthlyResponse | null>(null);
  const [loading, setLoading] = useState(false);

  const fetch = async () => {
    setLoading(true);
    try {
      const res = await billingAPI.platformMonthly(month.year(), month.month() + 1);
      setData(res.data);
    } catch (e: any) {
      message.error('載入失敗：' + e.message);
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { fetch(); }, [month]);

  if (!data) return <Card loading={loading}>載入中...</Card>;

  return (
    <>
      <Row gutter={16} style={{ marginBottom: 16 }}>
        <Col span={6}>
          <Card><Statistic title="本月總單數" value={data.overall.total_orders} /></Card>
        </Col>
        <Col span={6}>
          <Card><Statistic title="總車資" value={data.overall.total_fare} prefix="$" /></Card>
        </Col>
        <Col span={6}>
          <Card>
            <Statistic title="平台抽成" value={data.platform_share} prefix="$" precision={2} valueStyle={{ color: '#9C27B0' }} />
          </Card>
        </Col>
        <Col span={6}>
          <Card>
            <Statistic title="司機淨拿" value={data.overall.total_driver_net} prefix="$" precision={2} />
          </Card>
        </Col>
      </Row>
      <Row gutter={16} style={{ marginBottom: 16 }}>
        <Col span={6}>
          <Card><Statistic title="Queue 派單" value={data.overall.queue_orders}
            suffix={`/ ${data.overall.total_orders}`} valueStyle={{ color: '#FFA000' }} /></Card>
        </Col>
        <Col span={6}>
          <Card><Statistic title="一般派單" value={data.overall.regular_orders}
            suffix={`/ ${data.overall.total_orders}`} /></Card>
        </Col>
      </Row>

      <Card
        title="按合作對象拆分"
        extra={
          <Button icon={<DownloadOutlined />} onClick={() =>
            downloadCSV(
              `platform-${month.format('YYYY-MM')}.csv`,
              data.by_partner.map(r => ({
                partner_id: r.partner_id ?? 'PLATFORM',
                partner_role: r.partner_role,
                partner_name: r.partner_name ?? '平台',
                orders: r.orders,
                total_amount: r.total_amount,
              }))
            )
          }>匯出 CSV</Button>
        }
      >
        <Table
          rowKey={(r) => `${r.partner_id ?? 'PLATFORM'}-${r.partner_role}`}
          dataSource={data.by_partner}
          pagination={false}
          columns={[
            {
              title: '角色',
              dataIndex: 'partner_role',
              width: 100,
              render: (v: string) => <Tag color={PARTNER_TYPE_COLOR[v]}>{v}</Tag>,
            },
            { title: '名稱', dataIndex: 'partner_name', render: (v: string | null) => v ?? <em>平台 (PLATFORM)</em> },
            { title: '單數', dataIndex: 'orders', width: 100, align: 'right' as const },
            {
              title: '金額',
              dataIndex: 'total_amount',
              width: 120,
              align: 'right' as const,
              render: (v: number) => `$${Number(v).toFixed(2)}`,
            },
          ]}
        />
      </Card>
    </>
  );
};

// ============================================================
// Tab 2: 合作對象月報
// ============================================================
const PartnerReport: React.FC<{ month: Dayjs }> = ({ month }) => {
  const { message } = AntdApp.useApp();
  const [partners, setPartners] = useState<Partner[]>([]);
  const [partnerId, setPartnerId] = useState<string | null>(null);
  const [data, setData] = useState<BillingPartnerMonthlyResponse | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    partnerAPI.list(undefined, true).then(r => setPartners(r.data.data)).catch(() => {});
  }, []);

  const fetch = async () => {
    if (!partnerId) return;
    setLoading(true);
    try {
      const res = await billingAPI.partnerMonthly(partnerId, month.year(), month.month() + 1);
      setData(res.data);
    } catch (e: any) {
      message.error('載入失敗：' + e.message);
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { fetch(); }, [partnerId, month]);

  return (
    <>
      <Space style={{ marginBottom: 16 }}>
        <span>合作對象：</span>
        <Select
          style={{ width: 320 }}
          placeholder="選擇 partner"
          value={partnerId}
          onChange={setPartnerId}
          options={partners.map(p => ({
            value: p.partner_id,
            label: <Space><Tag color={PARTNER_TYPE_COLOR[p.type]}>{p.type}</Tag>{p.name}</Space>,
          }))}
        />
        <Button icon={<ReloadOutlined />} onClick={fetch} loading={loading} disabled={!partnerId}>重新整理</Button>
      </Space>

      {data && (
        <>
          {!data.reconciled && (
            <Alert
              type="error"
              showIcon
              message="🚨 對帳異常：Σ司機單數 ≠ snapshot 總數"
              description={`司機加總 ${data.sum_by_driver} 單，snapshot 總數 ${data.total_orders} 單。請檢查 distribution 是否完整覆蓋訂單。`}
              style={{ marginBottom: 16 }}
            />
          )}
          <Row gutter={16} style={{ marginBottom: 16 }}>
            <Col span={8}>
              <Card><Statistic title="本月總單數" value={data.total_orders} /></Card>
            </Col>
            <Col span={8}>
              <Card><Statistic title="總車資" value={data.total_revenue} prefix="$" /></Card>
            </Col>
            <Col span={8}>
              <Card>
                <Statistic title="該對象拿到" value={data.total_partner_share} prefix="$" precision={2}
                  valueStyle={{ color: '#1976D2' }} />
              </Card>
            </Col>
          </Row>

          <Card
            title="按司機分組"
            extra={
              <Button icon={<DownloadOutlined />} onClick={() =>
                downloadCSV(`partner-${partnerId}-${month.format('YYYY-MM')}.csv`, data.by_driver)
              }>匯出 CSV</Button>
            }
          >
            <Table
              rowKey="driver_id"
              dataSource={data.by_driver}
              pagination={false}
              columns={[
                { title: '司機 ID', dataIndex: 'driver_id', width: 130 },
                { title: '姓名', dataIndex: 'driver_name' },
                { title: '單數', dataIndex: 'orders', width: 100, align: 'right' as const },
                { title: '車資總計', dataIndex: 'revenue', width: 120, align: 'right' as const, render: (v: number) => `$${v}` },
                { title: '對象拿到', dataIndex: 'partner_share', width: 120, align: 'right' as const, render: (v: number) => `$${Number(v).toFixed(2)}` },
              ]}
            />
          </Card>
        </>
      )}
    </>
  );
};

// ============================================================
// Tab 3: 司機月結
// ============================================================
const DriverReport: React.FC<{ month: Dayjs }> = ({ month }) => {
  const { message } = AntdApp.useApp();
  const [drivers, setDrivers] = useState<any[]>([]);
  const [driverId, setDriverId] = useState<string | null>(null);
  const [data, setData] = useState<BillingDriverMonthlyResponse | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    driverAPI.getDrivers(undefined, 1, 500)
      .then((r: any) => setDrivers(r?.data?.data || r?.data?.items || r?.data || []))
      .catch(() => {});
  }, []);

  const fetch = async () => {
    if (!driverId) return;
    setLoading(true);
    try {
      const res = await billingAPI.driverMonthly(driverId, month.year(), month.month() + 1);
      setData(res.data);
    } catch (e: any) {
      message.error('載入失敗：' + e.message);
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { fetch(); }, [driverId, month]);

  return (
    <>
      <Space style={{ marginBottom: 16 }}>
        <span>司機：</span>
        <Select
          style={{ width: 320 }}
          placeholder="選擇司機"
          value={driverId}
          onChange={setDriverId}
          showSearch
          optionFilterProp="label"
          options={drivers.map((d: any) => ({
            value: d.driverId || d.driver_id,
            label: `${d.name || d.driverId} (${d.phone || ''})`,
          }))}
        />
        <Button icon={<ReloadOutlined />} onClick={fetch} loading={loading} disabled={!driverId}>重新整理</Button>
      </Space>

      {data && (
        <>
          <Row gutter={16} style={{ marginBottom: 16 }}>
            <Col span={6}>
              <Card><Statistic title="本月總單數" value={data.total_orders} /></Card>
            </Col>
            <Col span={6}>
              <Card><Statistic title="Queue 單" value={data.queue_orders}
                valueStyle={{ color: '#FFA000' }} /></Card>
            </Col>
            <Col span={6}>
              <Card><Statistic title="總車資" value={data.total_fare} prefix="$" /></Card>
            </Col>
            <Col span={6}>
              <Card><Statistic title="淨拿" value={data.total_driver_net} prefix="$" precision={2}
                valueStyle={{ color: '#4CAF50' }} /></Card>
            </Col>
          </Row>

          {data.partners.length > 0 && (
            <Card title="所屬合作關係" style={{ marginBottom: 16 }}>
              <Space>
                {data.partners.map(p => (
                  <Tag key={p.relationship_type} color={PARTNER_TYPE_COLOR[p.partner_type]}>
                    {p.relationship_type}: {p.partner_name}
                  </Tag>
                ))}
              </Space>
            </Card>
          )}

          <Card
            title={`本月訂單明細（${data.total_orders} 筆）`}
            extra={
              <Button icon={<DownloadOutlined />} onClick={() =>
                downloadCSV(`driver-${driverId}-${month.format('YYYY-MM')}.csv`, data.orders)
              }>匯出 CSV</Button>
            }
          >
            <Table
              rowKey="snapshot_id"
              dataSource={data.orders}
              pagination={{ pageSize: 50 }}
              size="small"
              columns={[
                { title: '訂單 ID', dataIndex: 'order_id', width: 130 },
                {
                  title: '完成時間',
                  dataIndex: 'completed_at',
                  width: 160,
                  render: (v: string) => dayjs(v).format('MM-DD HH:mm'),
                },
                {
                  title: '來源',
                  dataIndex: 'source',
                  width: 80,
                  render: (v: string) => <Tag>{v}</Tag>,
                },
                {
                  title: '類型',
                  dataIndex: 'dispatch_type',
                  width: 90,
                  render: (v: string, row: any) =>
                    v === 'QUEUE'
                      ? <Tag color="orange">Queue｜{row.zone_name || row.zone_id}</Tag>
                      : <Tag>一般</Tag>,
                },
                { title: '車資', dataIndex: 'fare', width: 80, align: 'right' as const, render: (v: number) => `$${v}` },
                { title: '抽成%', dataIndex: 'commission_pct', width: 80, align: 'right' as const, render: (v: number) => `${v}%` },
                {
                  title: '司機淨拿',
                  dataIndex: 'driver_net',
                  width: 100,
                  align: 'right' as const,
                  render: (v: number) => `$${Number(v).toFixed(2)}`,
                },
              ]}
            />
          </Card>
        </>
      )}
    </>
  );
};

export default Billing;
