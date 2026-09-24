import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Bot,
  Check,
  X,
  Trash2,
  Loader2,
  AlertCircle,
  Sparkles,
  BookMarked,
  Clock,
} from 'lucide-react';
import type { AiApprovalItem, AiPattern } from '../services/api';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { useRole } from '../hooks/useRole';
import { useToast } from '../hooks/useToast';
import {
  useAiStatusQuery,
  useAiApprovalsQuery,
  useAiPatternsQuery,
  useAiApproveMutation,
  useAiRejectMutation,
  useAiDeletePatternMutation,
} from '../hooks/queries';
import { PageHeader } from '../components/PageHeader';
import { Modal } from '../components/Modal';
import './AiApprovals.css';

type Tab = 'pending' | 'resolved' | 'patterns';

const formatWhen = (iso: string): string => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString();
};

export function AiApprovals() {
  const { t } = useTranslation();
  useDocumentTitle(t('ai.title'));
  const { canWrite } = useRole();
  const toast = useToast();

  const approveMutation = useAiApproveMutation();
  const rejectMutation = useAiRejectMutation();
  const deletePatternMutation = useAiDeletePatternMutation();

  const {
    data: status,
    isLoading: loadingStatus,
    isError: statusError,
  } = useAiStatusQuery();
  const { data: approvals = [], isLoading: loadingApprovals, isError: approvalsError } = useAiApprovalsQuery();
  const { data: patterns = [], isLoading: loadingPatterns, isError: patternsError } = useAiPatternsQuery();

  const [tab, setTab] = useState<Tab>('pending');
  const [deleteTarget, setDeleteTarget] = useState<AiPattern | null>(null);

  const pending = approvals.filter(a => a.status === 'pending');
  const resolved = approvals.filter(a => a.status !== 'pending');

  const loading = (tab === 'patterns' ? loadingPatterns : loadingApprovals) || loadingStatus;

  const handleApprove = async (item: AiApprovalItem) => {
    try {
      await approveMutation.mutateAsync(item.id);
      toast.success(t('ai.toasts.approved'));
    } catch (err) {
      toast.error(
        t('ai.toasts.approveFailed', {
          message: err instanceof Error ? err.message : t('common.unknownError'),
        }),
      );
    }
  };

  const handleReject = async (item: AiApprovalItem) => {
    try {
      await rejectMutation.mutateAsync(item.id);
      toast.success(t('ai.toasts.rejected'));
    } catch (err) {
      toast.error(
        t('ai.toasts.rejectFailed', {
          message: err instanceof Error ? err.message : t('common.unknownError'),
        }),
      );
    }
  };

  const handleDeletePattern = async () => {
    if (!deleteTarget) return;
    try {
      await deletePatternMutation.mutateAsync(deleteTarget.id);
      setDeleteTarget(null);
      toast.success(t('ai.toasts.patternDeleted'));
    } catch (err) {
      toast.error(
        t('ai.toasts.patternDeleteFailed', {
          message: err instanceof Error ? err.message : t('common.unknownError'),
        }),
      );
    }
  };

  if (loading) {
    return (
      <div
        className="ai-approvals-page"
        style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '400px' }}
      >
        <Loader2 className="animate-spin" size={32} />
      </div>
    );
  }

  return (
    <div className="ai-approvals-page">
      <PageHeader title={t('ai.title')} subtitle={t('ai.subtitle')} />

      {(statusError || approvalsError || patternsError) && (
        <div className="error-banner" role="alert">
          <AlertCircle size={20} />
          <span className="error-banner-text">{t('ai.loadError')}</span>
        </div>
      )}

      {/* Gate + health summary */}
      {status && (
        <div className="ai-status-row">
          <div className={`ai-status-pill ${status.enabled ? 'on' : 'off'}`}>
            <Bot size={14} />
            {status.enabled ? t('ai.status.enabled') : t('ai.status.disabled')}
          </div>
          <div className={`ai-status-pill ${status.approvalEnabled ? 'gate-on' : 'gate-off'}`}>
            <Clock size={14} />
            {status.approvalEnabled ? t('ai.status.approvalGate') : t('ai.status.approvalOff')}
          </div>
          <div className={`ai-status-pill ${status.llmReachable ? 'on' : 'off'}`}>
            <Sparkles size={14} />
            <span className="ai-status-model">{status.llmModel}</span>
            {status.llmReachable ? t('ai.status.reachable') : t('ai.status.unreachable')}
          </div>
          <div className="ai-status-pill neutral">
            <span>
              {t('ai.status.pendingCount', { count: status.pendingApprovals })}
            </span>
            <span aria-hidden="true" className="ai-status-sep">
              ·
            </span>
            <span>{t('ai.status.patternCount', { count: status.patternCount })}</span>
          </div>
        </div>
      )}

      {/* Tabs */}
      <div className="ai-tabs" role="tablist">
        <button
          role="tab"
          aria-selected={tab === 'pending'}
          className={`ai-tab-btn ${tab === 'pending' ? 'active' : ''}`}
          onClick={() => setTab('pending')}
        >
          {t('ai.tabs.pending')}
          {pending.length > 0 && <span className="ai-tab-count">{pending.length}</span>}
        </button>
        <button
          role="tab"
          aria-selected={tab === 'resolved'}
          className={`ai-tab-btn ${tab === 'resolved' ? 'active' : ''}`}
          onClick={() => setTab('resolved')}
        >
          {t('ai.tabs.resolved')}
        </button>
        <button
          role="tab"
          aria-selected={tab === 'patterns'}
          className={`ai-tab-btn ${tab === 'patterns' ? 'active' : ''}`}
          onClick={() => setTab('patterns')}
        >
          {t('ai.tabs.patterns')}
          {patterns.length > 0 && <span className="ai-tab-count">{patterns.length}</span>}
        </button>
      </div>

      {/* Pending approvals */}
      {tab === 'pending' && (
        <div role="tabpanel">
          {pending.length === 0 ? (
            <div className="empty-table-state">
              <Bot size={48} strokeWidth={1} />
              <h3>{t('ai.empty.pendingTitle')}</h3>
              <p>{t('ai.empty.pendingDescription')}</p>
            </div>
          ) : (
            <div className="ai-card-list">
              {pending.map(item => (
                <div key={item.id} className="ai-approval-card">
                  <div className="ai-card-header">
                    <div className="ai-card-header-left">
                      <span className={`ai-kind-tag ${item.kind}`}>
                        {item.kind === 'pattern' ? t('ai.kind.pattern') : t('ai.kind.draft')}
                      </span>
                      {item.kind === 'pattern' && item.confidence !== undefined && (
                        <span className="ai-confidence">
                          {Math.round(item.confidence * 100)}% {t('ai.kind.match')}
                        </span>
                      )}
                    </div>
                    <span className="ai-card-meta">
                      {item.sender} · {item.chatId}
                    </span>
                  </div>
                  <div className="ai-card-body">
                    <div className="ai-msg-block">
                      <span className="ai-msg-label">{t('ai.card.original')}</span>
                      <p className="ai-msg-text ai-msg-in">{item.originalMessage}</p>
                    </div>
                    <div className="ai-msg-block">
                      <span className="ai-msg-label">{t('ai.card.draft')}</span>
                      <p className="ai-msg-text ai-msg-out">{item.draftReply}</p>
                    </div>
                    {item.summary && (
                      <div className="ai-msg-block">
                        <span className="ai-msg-label">{t('ai.card.summary')}</span>
                        <p className="ai-msg-summary">{item.summary}</p>
                      </div>
                    )}
                  </div>
                  <div className="ai-card-footer">
                    <span className="ai-card-time">{formatWhen(item.createdAt)}</span>
                    <div className="ai-card-actions">
                      <button
                        className="btn-danger-outline"
                        onClick={() => handleReject(item)}
                        disabled={rejectMutation.isPending && rejectMutation.variables === item.id}
                      >
                        {rejectMutation.isPending && rejectMutation.variables === item.id ? (
                          <Loader2 size={16} className="animate-spin" />
                        ) : (
                          <X size={16} />
                        )}
                        {t('ai.actions.reject')}
                      </button>
                      <button
                        className="btn-primary"
                        onClick={() => handleApprove(item)}
                        disabled={approveMutation.isPending && approveMutation.variables === item.id}
                      >
                        {approveMutation.isPending && approveMutation.variables === item.id ? (
                          <Loader2 size={16} className="animate-spin" />
                        ) : (
                          <Check size={16} />
                        )}
                        {t('ai.actions.approve')}
                      </button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Resolved history */}
      {tab === 'resolved' && (
        <div role="tabpanel">
          {resolved.length === 0 ? (
            <div className="empty-table-state">
              <Clock size={48} strokeWidth={1} />
              <h3>{t('ai.empty.resolvedTitle')}</h3>
              <p>{t('ai.empty.resolvedDescription')}</p>
            </div>
          ) : (
            <div className="ai-resolved-list">
              {resolved.map(item => (
                <div key={item.id} className="ai-resolved-row">
                  <span className={`status-badge ai-resolved-status ${item.status}`}>
                    {t(`ai.resolved.${item.status}`)}
                  </span>
                  <span className="ai-resolved-chat">{item.chatId}</span>
                  <span className="ai-resolved-snippet">{item.draftReply.slice(0, 80)}</span>
                  <span className="ai-card-time">{formatWhen(item.resolvedAt || item.createdAt)}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Learned patterns */}
      {tab === 'patterns' && (
        <div role="tabpanel">
          {patterns.length === 0 ? (
            <div className="empty-table-state">
              <BookMarked size={48} strokeWidth={1} />
              <h3>{t('ai.empty.patternsTitle')}</h3>
              <p>{t('ai.empty.patternsDescription')}</p>
            </div>
          ) : (
            <div className="ai-card-list">
              {patterns.map(pattern => (
                <div key={pattern.id} className="ai-pattern-card">
                  <div className="ai-card-header">
                    <span className="ai-kind-tag pattern">{t('ai.kind.pattern')}</span>
                    <span className="ai-pattern-uses">
                      {t('ai.patterns.uses', { count: pattern.uses })}
                    </span>
                    {canWrite && (
                      <button
                        className="icon-btn danger"
                        title={t('ai.actions.deletePattern')}
                        onClick={() => setDeleteTarget(pattern)}
                      >
                        <Trash2 size={16} />
                      </button>
                    )}
                  </div>
                  <div className="ai-card-body">
                    {pattern.keywords.length > 0 && (
                      <div className="ai-msg-block">
                        <span className="ai-msg-label">{t('ai.patterns.keywords')}</span>
                        <div className="ai-keyword-tags">
                          {pattern.keywords.slice(0, 10).map(kw => (
                            <span key={kw} className="ai-keyword-tag">
                              {kw}
                            </span>
                          ))}
                        </div>
                      </div>
                    )}
                    <div className="ai-msg-block">
                      <span className="ai-msg-label">{t('ai.patterns.reply')}</span>
                      <p className="ai-msg-text ai-msg-out">{pattern.reply}</p>
                    </div>
                    {pattern.summary && (
                      <div className="ai-msg-block">
                        <span className="ai-msg-label">{t('ai.card.summary')}</span>
                        <p className="ai-msg-summary">{pattern.summary}</p>
                      </div>
                    )}
                  </div>
                  <div className="ai-card-footer">
                    <span className="ai-card-time">{formatWhen(pattern.lastUsed)}</span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {deleteTarget && (
        <Modal
          open
          onClose={() => setDeleteTarget(null)}
          title={t('ai.patterns.deleteTitle')}
          className="modal-sm"
          closeLabel={t('common.close')}
          footer={
            <>
              <button className="btn-secondary" onClick={() => setDeleteTarget(null)}>
                {t('common.cancel')}
              </button>
              <button className="btn-danger" onClick={handleDeletePattern}>
                {t('common.delete')}
              </button>
            </>
          }
        >
          <p>{t('ai.patterns.deleteConfirm')}</p>
          <p className="ai-msg-text ai-msg-out">{deleteTarget.reply}</p>
        </Modal>
      )}
    </div>
  );
}