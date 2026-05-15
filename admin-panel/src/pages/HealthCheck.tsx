import React, { useEffect, useState } from 'react';
import {
  Card, Table, Tag, Button, Space, App as AntdApp, Typography,
  Alert, Collapse, Spin, Statistic, Row, Col,
} from 'antd';
import {
  ReloadOutlined, ToolOutlined, CheckCircleOutlined,
  WarningOutlined, ExclamationCircleOutlined,
} from '@ant-design/icons';
import { healthAPI } from '../services/api';

const { Title, Text, Paragraph } = Typography;

interface HealthCheck {
  id: string;
  title: string;
  description: string;
  severity: 'high' | 'medium' | 'low';
  count: number;
  items: any[];
  pages: string[];
  auto_fix_endpoint?: string;
}

interface HealthResponse {
  success: boolean;
  scanned_at: string;
  checks: HealthCheck[];
  total_issues: number;
  high_severity_count: number;
}

const SEVERITY_COLOR: Record<string, string> = { high: 'red', medium: 'orange', low: 'blue' };
const SEVERITY_LABEL: Record<string, string> = { high: '高', medium: '中', low: '低' };

const HealthCheck: React.FC = () => {
  const { message } = AntdApp.useApp();
  const [data, setData] = useState<HealthResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [fixing, setFixing] = useState<string | null>(null);

  const fetchHealth = async () => {
    setLoading(true);
    try {
      const res = await healthAPI.check();
      setData(res.data);
    } catch (e: any) {
      message.error('健康檢查失敗：' + (e.response?.data?.error || e.message));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { fetchHealth(); }, []);

  const handleAutoFix = async (check: HealthCheck) => {
    if (!check.auto_fix_endpoint) return;
    setFixing(check.id);
    try {
      const res = await healthAPI.autoFix(check.id);
      message.success(`✓ ${check.title} 已清理 ${res.data.fixed} 筆`);
      await fetchHealth();
    } catch (e: any) {
      message.error('清理失敗：' + (e.response?.data?.error || e.message));
    } finally {
      setFixing(null);
    }
  };

  if (loading && !data) {
    return <div style={{ textAlign: 'center', padding: 60 }}><Spin size="large" /></div>;
  }

  if (!data) return null;

  const issueChecks = data.checks.filter(c => c.count > 0);
  const cleanChecks = data.checks.filter(c => c.count === 0);

  return (
    <div style={{ padding: 24 }}>
      <Title level={3}>
        <ToolOutlined /> 系統健康
      </Title>
      <Paragraph type="secondary">
        Schema-level 防呆 + 應用層持續監控（每次進此頁自動掃描）。掃描時間：{new Date(data.scanned_at).toLocaleString('zh-TW')}
      </Paragraph>

      <Row gutter={16} style={{ marginBottom: 24 }}>
        <Col span={6}>
          <Card>
            <Statistic
              title="高嚴重度問題"
              value={data.high_severity_count}
              valueStyle={{ color: data.high_severity_count > 0 ? '#cf1322' : '#3f8600' }}
              prefix={data.high_severity_count > 0 ? <WarningOutlined /> : <CheckCircleOutlined />}
            />
          </Card>
        </Col>
        <Col span={6}>
          <Card>
            <Statistic
              title="總異常類別"
              value={data.total_issues}
              suffix={`/ ${data.checks.length}`}
            />
          </Card>
        </Col>
        <Col span={12}>
          <Card>
            <Space>
              <Button type="primary" icon={<ReloadOutlined />} onClick={fetchHealth} loading={loading}>
                重新掃描
              </Button>
              <Text type="secondary">
                schema-level trigger / partial unique 已在 DB 層強制，這頁只顯示舊資料殘留 + 業務異常
              </Text>
            </Space>
          </Card>
        </Col>
      </Row>

      {issueChecks.length === 0 && (
        <Alert
          type="success"
          showIcon
          message="✓ 全部健康，無異常"
          description="所有 schema constraint 跟 trigger 都正常工作。沒有殘留或異常資料。"
          style={{ marginBottom: 16 }}
        />
      )}

      {issueChecks.map(check => (
        <Card
          key={check.id}
          style={{ marginBottom: 16, borderColor: check.severity === 'high' ? '#ff4d4f' : undefined }}
          title={
            <Space>
              <Tag color={SEVERITY_COLOR[check.severity]}>
                <ExclamationCircleOutlined /> {SEVERITY_LABEL[check.severity]}
              </Tag>
              <span>{check.title}</span>
              <Tag>{check.count} 筆</Tag>
            </Space>
          }
          extra={
            check.auto_fix_endpoint && (
              <Button
                type="primary"
                danger
                icon={<ToolOutlined />}
                loading={fixing === check.id}
                onClick={() => handleAutoFix(check)}
              >
                一鍵清理
              </Button>
            )
          }
        >
          <Paragraph type="secondary">{check.description}</Paragraph>
          {check.items.length > 0 && (
            <Collapse>
              <Collapse.Panel header={`展開檢視（${check.items.length} 筆）`} key="1">
                <pre style={{ fontSize: 12, maxHeight: 300, overflow: 'auto' }}>
                  {JSON.stringify(check.items, null, 2)}
                </pre>
              </Collapse.Panel>
            </Collapse>
          )}
        </Card>
      ))}

      {cleanChecks.length > 0 && (
        <Card title={<Space><CheckCircleOutlined /> 通過檢查 ({cleanChecks.length})</Space>} size="small">
          <Space wrap>
            {cleanChecks.map(c => (
              <Tag key={c.id} color="green">✓ {c.title}</Tag>
            ))}
          </Space>
        </Card>
      )}
    </div>
  );
};

export default HealthCheck;
