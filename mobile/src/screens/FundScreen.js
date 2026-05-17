/**
 * FundScreen — DGA Capital Fund I / Managed Portfolio hub
 *
 * Password gate:  enter "genesis" (FUND_PASSWORD env var) to unlock.
 *   • Wrong password  → server returns 403  → show "Incorrect password"
 *   • 403 on data call → token invalidated  → re-lock
 *   • Main auth token is never affected by fund auth failures
 *
 * Two branches (top selector):
 *   LP Fund       — multi-LP fund with NAV, waterfall, carry calculations
 *   My Portfolio  — Fidelity CSV upload, Modified Dietz YTD, per-stock
 *                   attribution, past runs, paper portfolios link
 *
 * Sub-tabs (LP Fund branch): Overview | LPs | Positions | Activity | Waterfall
 */
import React, { useState, useCallback, useRef, useEffect } from 'react';
import {
  View, Text, ScrollView, RefreshControl, TextInput,
  StyleSheet, ActivityIndicator, TouchableOpacity,
  KeyboardAvoidingView, Platform, Alert, Switch, Linking,
} from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as DocumentPicker from 'expo-document-picker';
import { Ionicons } from '@expo/vector-icons';
import AppHeader from '../components/AppHeader';
import { colors } from '../components/theme';
import { api, getFundToken, setFundToken, clearFundToken } from '../api/client';

const LAST_PORTFOLIO_KEY = '@dga_last_portfolio';

// ── Helpers ───────────────────────────────────────────────────────────────────
// All dollar amounts on the fund/portfolio pages display as whole dollars (no cents).
const fmt$ = (n) => {
  if (n == null) return '—';
  const abs = Math.abs(n);
  return (n < 0 ? '−$' : '$') + Math.round(abs).toLocaleString('en-US', { maximumFractionDigits: 0 });
};
const fmt$0 = fmt$;  // alias — both render whole dollars
const fmtPct = (n, decimals = 1) => {
  if (n == null) return '—';
  const sign = n >= 0 ? '+' : '';
  return sign + Number(n).toFixed(decimals) + '%';
};
const fmtCat = (cat) =>
  (cat || '').replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
const pctColor = (x) =>
  x == null ? '#8090a8' : x > 0 ? '#16A34A' : x < 0 ? '#DC2626' : '#8090a8';

const BRANCHES = ['LP Fund', 'Managed Account', 'Rebalanced'];
const LP_TABS  = ['Overview', 'LPs', 'Positions', 'Activity', 'Waterfall'];

export default function FundScreen({ navigation }) {
  // ── Auth state ───────────────────────────────────────────────────────────
  const [locked,    setLocked]    = useState(true);
  const [password,  setPassword]  = useState('');
  const [authError, setAuthError] = useState(false);
  const [authBusy,  setAuthBusy]  = useState(false);

  // ── Branch / tab state ───────────────────────────────────────────────────
  const [branch,    setBranch]    = useState('LP Fund');
  const [activeTab, setActiveTab] = useState('Overview');

  // ── Multi-fund list state ────────────────────────────────────────────────
  // activeFundId = null  → show the fund list summary view
  // activeFundId = <id>  → show full detail (sub-tabs) for that fund
  const [fundList,       setFundList]       = useState([]);
  const [fundListLoading,setFundListLoading]= useState(false);
  const [fundListError,  setFundListError]  = useState(null);
  const [activeFundId,   setActiveFundId]   = useState(null);
  const [activeFundName, setActiveFundName] = useState('');

  // ── LP Fund data state ───────────────────────────────────────────────────
  const [overview,   setOverview]  = useState(null);
  const [lps,        setLps]       = useState([]);
  const [positions,  setPositions] = useState([]);
  const [activity,   setActivity]  = useState([]);
  const [waterfall,  setWaterfall] = useState(null);
  const [loading,    setLoading]   = useState(false);
  const [refreshing, setRefreshing]= useState(false);
  const [error,      setError]     = useState(null);

  // ── My Portfolio (YTD) state ─────────────────────────────────────────────
  const [ytdPosFile,     setYtdPosFile]     = useState(null);
  const [ytdActFile,     setYtdActFile]     = useState(null);
  const [ytdMonthlyFile, setYtdMonthlyFile] = useState(null);
  const [ytdBeginValue,  setYtdBeginValue]  = useState('');
  const [ytdSubmitting,  setYtdSubmitting]  = useState(false);
  const [ytdResult,      setYtdResult]      = useState(null);
  const [ytdError,       setYtdError]       = useState(null);
  const [ytdSnapshots,   setYtdSnapshots]   = useState([]);

  // ── Managed Account list + detail state ─────────────────────────────────
  const [managedAccList,       setManagedAccList]       = useState([]);
  const [managedAccLoading,    setManagedAccLoading]    = useState(false);
  const [activeManagedAccId,   setActiveManagedAccId]   = useState(null);
  const [activeManagedAccName, setActiveManagedAccName] = useState('');
  // Detail view state — null = show list, set = show detail for that account
  const [acctDetailId,     setAcctDetailId]     = useState(null);
  const [acctDetailName,   setAcctDetailName]   = useState('');
  const [acctOverview,     setAcctOverview]     = useState(null);
  const [acctPositions,    setAcctPositions]    = useState([]);
  const [acctFlows,        setAcctFlows]        = useState([]);
  const [acctLoadingDetail,setAcctLoadingDetail]= useState(false);
  // Create account form state
  const [showCreateAcct,  setShowCreateAcct]  = useState(false);
  const [newAcctName,     setNewAcctName]     = useState('');
  const [newAcctShort,    setNewAcctShort]    = useState('');
  const [newAcctInception,setNewAcctInception]= useState('');
  const [newAcctFee,      setNewAcctFee]      = useState('1');
  const [createAcctBusy,  setCreateAcctBusy]  = useState(false);
  const [createAcctStatus,setCreateAcctStatus]= useState(null);

  // ── Rename fund / account state ──────────────────────────────────────────
  const [renamingId,    setRenamingId]    = useState(null);   // fund id currently being renamed
  const [renameNameVal, setRenameNameVal] = useState('');
  const [renameShortVal,setRenameShortVal]= useState('');
  const [renameBusy,    setRenameBusy]    = useState(false);
  const [renameMsg,     setRenameMsg]     = useState(null);   // {ok, text}

  const startRename = (item) => {
    setRenamingId(item.id || item.fund_id);
    setRenameNameVal(item.name || item.account_name || '');
    setRenameShortVal(item.short_name || '');
    setRenameMsg(null);
  };
  const cancelRename = () => { setRenamingId(null); setRenameMsg(null); };
  const submitRename = async (fundId) => {
    const newName  = renameNameVal.trim();
    const newShort = renameShortVal.trim().toUpperCase();
    if (!newName || !newShort) {
      setRenameMsg({ ok: false, text: 'Name and short code are required.' });
      return;
    }
    setRenameBusy(true);
    setRenameMsg(null);
    try {
      const r = await api.renameFund(fundId, newName, newShort);
      setRenameMsg({ ok: true, text: `✓ Renamed to "${newName}" (${newShort})` });
      // Refresh both lists so the new name shows immediately
      loadFundList();
      loadManagedAccList(activeManagedAccId);
      setTimeout(() => { setRenamingId(null); setRenameMsg(null); }, 1200);
    } catch (e) {
      setRenameMsg({ ok: false, text: e.message || 'Rename failed.' });
    } finally {
      setRenameBusy(false);
    }
  };

  // ── Fund import state ────────────────────────────────────────────────────
  const [importPosStatus,  setImportPosStatus]  = useState(null);  // {ok, msg}
  const [importCtStatus,   setImportCtStatus]   = useState(null);  // {ok, msg}
  const [importPosLoading, setImportPosLoading] = useState(false);
  const [importCtLoading,  setImportCtLoading]  = useState(false);

  // ── Live SPY YTD comparison ──────────────────────────────────────────────
  // Populated when a YTD result is displayed; refreshes from /api/market/spy-ytd
  const [spyLive, setSpyLive] = useState(null);

  // ── Rebalance state ──────────────────────────────────────────────────────
  const [rebalFile,         setRebalFile]         = useState(null);
  const [rebalReuseCache,   setRebalReuseCache]   = useState(true);
  const [rebalGenerateGamma,setRebalGenerateGamma]= useState(false);
  const [rebalSubmitting,   setRebalSubmitting]   = useState(false);
  const [rebalJob,          setRebalJob]          = useState(null);
  const [rebalError,        setRebalError]        = useState(null);
  const [lastRebal,         setLastRebal]         = useState(null);
  const rebalPollRef = useRef(null);

  // ── Check token on focus ─────────────────────────────────────────────────
  useFocusEffect(useCallback(() => {
    let active = true;
    (async () => {
      const token = await getFundToken();
      if (!active) return;
      if (token) { setLocked(false); }
      else        { setLocked(true); }
    })();
    return () => { active = false; };
  }, []));

  // When unlocked, load fund list, managed accounts, and YTD snapshots
  useFocusEffect(useCallback(() => {
    if (!locked) {
      loadFundList();
      loadYtdSnapshots();
      loadManagedAccList(null);
    }
  }, [locked])); // eslint-disable-line

  // ── Live SPY YTD: fetch whenever a YTD result is displayed ──────────────
  useEffect(() => {
    if (!ytdResult) return;
    let cancelled = false;
    (async () => {
      try {
        const data = await api.getSpyYtd();
        if (!cancelled && data?.ytd_pct != null) setSpyLive(data);
      } catch (_) { /* fail silently */ }
    })();
    return () => { cancelled = true; };
  }, [ytdResult]); // eslint-disable-line

  // ── Auth submit ──────────────────────────────────────────────────────────
  const submitPassword = async () => {
    const pw = password.trim();
    if (!pw) return;
    setAuthBusy(true);
    setAuthError(false);
    try {
      const { fund_token } = await api.fundAuth(pw);
      await setFundToken(fund_token);
      setPassword('');
      setLocked(false);
    } catch (e) {
      setAuthError(true);
      setPassword('');
    } finally {
      setAuthBusy(false);
    }
  };

  // ── Fund list loading ────────────────────────────────────────────────────
  const loadFundList = useCallback(async () => {
    setFundListLoading(true);
    setFundListError(null);
    try {
      // Only load LP funds in this branch; managed accounts are under 'Managed Account'
      const list = await api.fundList('lp_fund');
      const raw = Array.isArray(list) ? list : [];
      // Deduplicate by ID (guard against rare DB duplicates)
      const seen = new Set();
      setFundList(raw.filter(f => { if (seen.has(f.id)) return false; seen.add(f.id); return true; }));
    } catch (e) {
      if (e.message?.includes('403')) {
        await clearFundToken();
        setLocked(true);
        return;
      }
      setFundListError(e.message || 'Failed to load funds');
    } finally {
      setFundListLoading(false);
    }
  }, []);

  // ── LP Fund detail loading ───────────────────────────────────────────────
  const loadData = useCallback(async (isRefresh = false, fundId = null) => {
    if (!isRefresh) setLoading(true);
    setError(null);
    try {
      const fid = fundId || activeFundId;
      const [ov, lpData, posData, actData, wfall] = await Promise.all([
        api.fundOverview(fid),
        api.fundLps(fid),
        api.fundPositions(fid),
        api.fundActivity(fid),
        api.fundWaterfall(fid),
      ]);
      setOverview(ov);
      setLps(Array.isArray(lpData) ? lpData : []);
      setPositions(Array.isArray(posData) ? posData : []);
      setActivity(Array.isArray(actData) ? actData : []);
      setWaterfall(wfall);
    } catch (e) {
      if (e.message?.includes('403')) {
        await clearFundToken();
        setLocked(true);
        return;
      }
      setError(e.message || 'Failed to load fund data');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  // ── YTD snapshots ────────────────────────────────────────────────────────
  const loadYtdSnapshots = useCallback(async () => {
    try {
      const data = await api.listYtdSnapshots();
      setYtdSnapshots(Array.isArray(data?.snapshots) ? data.snapshots : []);
    } catch (_) {}
  }, []);

  // ── Load cached YTD from DB for a given managed account ─────────────────
  const loadYtdCacheForAccount = useCallback(async (accId) => {
    if (!accId) return;
    try {
      const cached = await api.getYtdCache(accId);
      if (cached?.result_json) {
        setYtdResult(JSON.parse(cached.result_json));
      }
    } catch (_) {
      // 404 = no cache yet — that's fine
    }
  }, []);

  // ── Managed account list (for YTD cache persistence) ────────────────────
  const loadManagedAccList = useCallback(async (currentAccId) => {
    setManagedAccLoading(true);
    try {
      const list = await api.fundList('managed_account');
      const raw = Array.isArray(list) ? list : [];
      const seen = new Set();
      const deduped = raw.filter(f => {
        if (seen.has(f.id)) return false;
        seen.add(f.id);
        return true;
      });
      setManagedAccList(deduped);
      // Auto-select the first account if none is selected yet
      if (deduped.length > 0 && !currentAccId) {
        const first = deduped[0];
        setActiveManagedAccId(first.id);
        setActiveManagedAccName(first.name || first.short_name || 'Account');
        loadYtdCacheForAccount(first.id);
      }
    } catch (e) {
      if (e.message?.includes('403')) {
        await clearFundToken();
        setLocked(true);
      }
    } finally {
      setManagedAccLoading(false);
    }
  }, [loadYtdCacheForAccount]); // eslint-disable-line

  // ── Open managed account detail ──────────────────────────────────────────
  const openAcctDetail = useCallback(async (acc) => {
    setAcctDetailId(acc.id);
    setAcctDetailName(acc.name || acc.short_name || 'Account');
    setActiveManagedAccId(acc.id);
    setActiveManagedAccName(acc.name || acc.short_name || 'Account');
    setAcctOverview(null);
    setAcctPositions([]);
    setAcctFlows([]);
    setYtdResult(null);
    setAcctLoadingDetail(true);
    try {
      const [ov, pos, cache] = await Promise.allSettled([
        api.fundOverview(acc.id),
        api.fundPositions(acc.id),
        api.getYtdCache(acc.id),
      ]);
      if (ov.status === 'fulfilled')  setAcctOverview(ov.value);
      if (pos.status === 'fulfilled') setAcctPositions(Array.isArray(pos.value) ? pos.value : []);
      if (cache.status === 'fulfilled' && cache.value?.result_json) {
        const data = JSON.parse(cache.value.result_json);
        setYtdResult(data);
        setAcctFlows(data.flows || []);
      }
    } catch (_) {}
    finally { setAcctLoadingDetail(false); }
  }, []);

  // ── Create managed account ───────────────────────────────────────────────
  const submitCreateAccount = useCallback(async () => {
    const name  = newAcctName.trim();
    const short = newAcctShort.trim();
    let inc     = newAcctInception.trim();
    if (!name || !short || !inc) {
      setCreateAcctStatus({ ok: false, msg: 'Name, short name, and inception date are required.' });
      return;
    }
    if (/^\d{4}$/.test(inc)) inc = inc + '-01-01';
    setCreateAcctBusy(true);
    setCreateAcctStatus(null);
    try {
      await api.createFund({
        name, short_name: short, inception_date: inc,
        mgmt_fee_pct: parseFloat(newAcctFee || '1') / 100,
        carry_pct: 0, hurdle_pct: 0, fund_type: 'managed_account',
      });
      setCreateAcctStatus({ ok: true, msg: `✓ Account "${name}" created!` });
      setNewAcctName(''); setNewAcctShort(''); setNewAcctInception(''); setNewAcctFee('1');
      setShowCreateAcct(false);
      loadManagedAccList(null);
    } catch (e) {
      setCreateAcctStatus({ ok: false, msg: e.message });
    } finally {
      setCreateAcctBusy(false);
    }
  }, [newAcctName, newAcctShort, newAcctInception, newAcctFee, loadManagedAccList]);

  // ── File picker ──────────────────────────────────────────────────────────
  const pickCsv = async (setter) => {
    try {
      const res = await DocumentPicker.getDocumentAsync({
        type: ['text/csv', 'text/comma-separated-values', 'application/csv', '*/*'],
        copyToCacheDirectory: true,
      });
      if (!res.canceled && res.assets?.[0]) setter(res.assets[0]);
    } catch (e) {
      Alert.alert('File picker error', e.message);
    }
  };

  // ── Fund: import positions (Fidelity CSV) ───────────────────────────────
  const importPositions = async () => {
    try {
      const res = await DocumentPicker.getDocumentAsync({
        type: ['text/csv', 'text/comma-separated-values', 'application/csv', '*/*'],
        copyToCacheDirectory: true,
      });
      if (res.canceled || !res.assets?.[0]) return;
      const asset = res.assets[0];
      setImportPosLoading(true);
      setImportPosStatus(null);
      const data = await api.fundImportPositions({
        fileUri:  asset.uri,
        fileName: asset.name,
        mimeType: asset.mimeType,
        fundId:   activeFundId,
      });
      const n   = data.imported || 0;
      const mkt = data.market_value_total != null ? ` · Mkt ${fmt$(data.market_value_total)}` : '';
      setImportPosStatus({ ok: true, msg: `✓ Imported ${n} positions${mkt}` });
      // Reload positions
      const fresh = await api.fundPositions(activeFundId);
      setPositions(Array.isArray(fresh) ? fresh : []);
    } catch (e) {
      setImportPosStatus({ ok: false, msg: `✗ ${e.message}` });
    } finally {
      setImportPosLoading(false);
    }
  };

  // ── Fund: import cap table (CSV or XLSX) ─────────────────────────────────
  const importCaptable = async () => {
    try {
      const res = await DocumentPicker.getDocumentAsync({
        type: ['text/csv', 'application/csv',
               'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
               'application/vnd.ms-excel', '*/*'],
        copyToCacheDirectory: true,
      });
      if (res.canceled || !res.assets?.[0]) return;
      const asset = res.assets[0];
      setImportCtLoading(true);
      setImportCtStatus(null);
      const data = await api.fundImportCaptable({
        fileUri:  asset.uri,
        fileName: asset.name,
        mimeType: asset.mimeType,
        fundId:   activeFundId,
      });
      const n = data.imported || 0;
      setImportCtStatus({ ok: true, msg: `✓ Imported ${n} LP records` });
      // Reload LPs
      const fresh = await api.fundLps(activeFundId);
      setLps(Array.isArray(fresh) ? fresh : []);
    } catch (e) {
      setImportCtStatus({ ok: false, msg: `✗ ${e.message}` });
    } finally {
      setImportCtLoading(false);
    }
  };

  // ── YTD compute ──────────────────────────────────────────────────────────
  const submitYtd = async () => {
    if (!ytdPosFile || !ytdActFile) {
      setYtdError('Positions and Activity CSVs are required.');
      return;
    }
    setYtdSubmitting(true);
    setYtdError(null);
    setYtdResult(null);
    try {
      const data = await api.computeUnifiedYtd({
        positionsUri:  ytdPosFile.uri,
        positionsName: ytdPosFile.name,
        positionsType: ytdPosFile.mimeType,
        activityUri:   ytdActFile.uri,
        activityName:  ytdActFile.name,
        activityType:  ytdActFile.mimeType,
        ...(ytdMonthlyFile ? {
          monthlyPerfUri:  ytdMonthlyFile.uri,
          monthlyPerfName: ytdMonthlyFile.name,
          monthlyPerfType: ytdMonthlyFile.mimeType,
        } : {}),
        beginValue: ytdBeginValue ? parseFloat(ytdBeginValue) : null,
      });
      setYtdResult(data);
      loadYtdSnapshots();
      // Persist to DB so the result survives Railway redeploys
      if (activeManagedAccId) {
        api.saveYtdCache(
          activeManagedAccId,
          data.end_value ?? 0,
          data.md_return_pct ?? 0,
          JSON.stringify(data),
        ).catch(() => {});
      }
    } catch (e) {
      setYtdError(e.message || 'Computation failed.');
    } finally {
      setYtdSubmitting(false);
    }
  };

  // ── Delete YTD snapshot ──────────────────────────────────────────────────
  const deleteSnapshot = (id) => {
    Alert.alert(
      'Delete run?',
      'This YTD snapshot will be permanently deleted.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Delete', style: 'destructive', onPress: async () => {
          try {
            await api.deleteYtdSnapshot(id);
            loadYtdSnapshots();
          } catch (e) {
            Alert.alert('Error', e.message);
          }
        }},
      ]
    );
  };

  const onRefresh = () => {
    setRefreshing(true);
    if (activeFundId) {
      loadData(true, activeFundId);
    } else {
      loadFundList();
    }
    loadYtdSnapshots();
  };

  // Open a specific fund's detail view
  const openFundDetail = (fund) => {
    setActiveFundId(fund.id);
    setActiveFundName(fund.name || fund.short_name || 'Fund');
    setActiveTab('Overview');
    setOverview(null);
    setLps([]);
    setPositions([]);
    setActivity([]);
    setWaterfall(null);
    loadData(false, fund.id);
  };

  // Back to fund list
  const closeFundDetail = () => {
    setActiveFundId(null);
    setActiveFundName('');
  };

  // ── Rebalance functions ──────────────────────────────────────────────────
  const pickRebalFile = async () => {
    try {
      const result = await DocumentPicker.getDocumentAsync({
        type: '*/*',
        copyToCacheDirectory: true,
        multiple: false,
      });
      if (result?.canceled) return;
      const asset = result?.assets?.[0] || (result?.uri ? result : null);
      if (!asset?.uri) {
        Alert.alert('No file selected', 'Could not read the selected file. Try again.');
        return;
      }
      setRebalFile({
        uri:      asset.uri,
        name:     asset.name     || 'portfolio.csv',
        mimeType: asset.mimeType || asset.type || 'application/octet-stream',
        size:     asset.size,
      });
      setRebalJob(null);
      setRebalError(null);
    } catch (err) {
      Alert.alert('Could not pick file', err.message || String(err));
    }
  };

  const startRebal = async () => {
    if (!rebalFile) {
      Alert.alert('No file selected', 'Please choose a portfolio CSV or XLSX first.');
      return;
    }
    setRebalSubmitting(true);
    setRebalError(null);
    setRebalJob(null);
    try {
      const resp = await api.startPortfolio({
        fileUri:      rebalFile.uri,
        fileName:     rebalFile.name,
        mimeType:     rebalFile.mimeType,
        strategy:     'current',
        reuseExisting: rebalReuseCache,
        generateGamma: rebalGenerateGamma,
      });
      setRebalJob(resp);
      if (rebalPollRef.current) clearInterval(rebalPollRef.current);
      rebalPollRef.current = setInterval(() => pollRebalJob(resp.job_id), 4000);
    } catch (err) {
      const msg = err?.message || String(err);
      setRebalError(msg);
    } finally {
      setRebalSubmitting(false);
    }
  };

  const pollRebalJob = async (jobId) => {
    try {
      const j = await api.getPortfolioJob(jobId);
      setRebalJob(j);
      if (j.status === 'done') {
        clearInterval(rebalPollRef.current);
        rebalPollRef.current = null;
        const payload = {
          job_id: jobId,
          n_tickers: j.n_tickers,
          strategy: j.strategy,
          completed_at: new Date().toISOString(),
          result: j.result,
          input_weights: j.input_weights || {},
        };
        AsyncStorage.setItem(LAST_PORTFOLIO_KEY, JSON.stringify(payload)).catch(() => {});
        setLastRebal(payload);
      } else if (j.status === 'failed') {
        clearInterval(rebalPollRef.current);
        rebalPollRef.current = null;
      }
    } catch (err) {
      clearInterval(rebalPollRef.current);
      setRebalError(err.message);
    }
  };

  const openRebalDownload = async () => {
    if (!rebalJob?.job_id) return;
    const url = await api.portfolioDownloadUrl(rebalJob.job_id);
    Linking.openURL(url);
  };

  const openLastRebalDownload = async () => {
    if (!lastRebal?.job_id) return;
    const url = await api.portfolioDownloadUrl(lastRebal.job_id);
    Linking.openURL(url);
  };

  // Load last rebal on focus — merge server (Dropbox-persisted) + local AsyncStorage.
  // Whichever has the newer completed_at wins, so the phone and web always show
  // the same last run regardless of which device triggered it.
  useFocusEffect(useCallback(() => {
    (async () => {
      // Read local cache first so the card appears instantly
      let local = null;
      try {
        const raw = await AsyncStorage.getItem(LAST_PORTFOLIO_KEY);
        if (raw) local = JSON.parse(raw);
      } catch (_) {}

      if (local) setLastRebal(local);

      // Then fetch from server; use it if it's newer (or if local is empty)
      try {
        const server = await api.getLastPortfolioJob();
        if (server?.completed_at) {
          const serverTs = new Date(server.completed_at).getTime();
          const localTs  = local?.completed_at ? new Date(local.completed_at).getTime() : 0;
          if (serverTs >= localTs) {
            setLastRebal(server);
            // Back-fill local cache so the next cold open is instant
            AsyncStorage.setItem(LAST_PORTFOLIO_KEY, JSON.stringify(server)).catch(() => {});
          }
        }
      } catch (_) { /* offline or no run yet — local value stays */ }
    })();
    return () => { if (rebalPollRef.current) clearInterval(rebalPollRef.current); };
  }, [])); // eslint-disable-line

  // ── Lock screen ──────────────────────────────────────────────────────────
  if (locked) {
    return (
      <View style={s.screen}>
        <AppHeader title="Fund Admin" subtitle="DGA Capital Fund I, LP" />
        <KeyboardAvoidingView
          style={s.lockOuter}
          behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        >
          <View style={s.lockCard}>
            <Text style={s.lockIcon}>🔒</Text>
            <Text style={s.lockTitle}>Fund Access</Text>
            <Text style={s.lockHint}>Enter the fund password to continue.</Text>
            <TextInput
              style={[s.lockInput, authError && s.lockInputError]}
              value={password}
              onChangeText={txt => { setPassword(txt); setAuthError(false); }}
              placeholder="Fund password"
              placeholderTextColor="#3a5070"
              secureTextEntry
              autoCapitalize="none"
              autoCorrect={false}
              onSubmitEditing={submitPassword}
              returnKeyType="go"
              autoFocus
            />
            {authError && <Text style={s.lockErrText}>Incorrect password — try again</Text>}
            <TouchableOpacity
              style={[s.lockBtn, authBusy && { opacity: 0.6 }]}
              onPress={submitPassword}
              disabled={authBusy}
            >
              <Text style={s.lockBtnText}>{authBusy ? 'Checking…' : 'Unlock'}</Text>
            </TouchableOpacity>
          </View>
        </KeyboardAvoidingView>
      </View>
    );
  }

  // ── Branch: My Portfolio ─────────────────────────────────────────────────
  function FileRow({ label, file, onPick, required }) {
    return (
      <TouchableOpacity style={s.fileRow} onPress={onPick} activeOpacity={0.75}>
        <View style={s.fileRowLeft}>
          <Text style={s.fileRowLabel}>
            {label}
            {required && <Text style={s.fileRowReq}> *</Text>}
          </Text>
          <Text style={s.fileRowName} numberOfLines={1}>
            {file ? file.name : 'Tap to select CSV'}
          </Text>
        </View>
        <View style={[s.fileRowIcon, file && s.fileRowIconDone]}>
          <Text style={{ fontSize: 14 }}>{file ? '✓' : '+'}</Text>
        </View>
      </TouchableOpacity>
    );
  }

  // ── SPY comparison card ─────────────────────────────────────────────────
  // Shows S&P 500 YTD vs portfolio alpha. Portfolio YTD is already shown
  // above in the main metrics row — no need to repeat it here.
  function SpyComparisonCard({ portfolioPct }) {
    const spyPct  = spyLive?.ytd_pct ?? ytdResult?.spy_return_pct ?? null;
    const isLive  = spyLive != null;
    const asOf    = spyLive?.as_of ?? null;
    if (spyPct == null) return null;
    const alpha    = portfolioPct != null && spyPct != null ? portfolioPct - spyPct : null;
    const alphaPos = alpha != null && alpha >= 0;
    return (
      <View style={s.spyCard}>
        <Text style={s.spyCardTitle}>
          S&P 500 COMPARISON{isLive ? '  ·  ' : ''}
          {isLive && <Text style={s.spyLiveBadge}>LIVE{asOf ? `  ${asOf}` : ''}</Text>}
        </Text>
        <View style={s.spyCardRow}>
          {/* S&P 500 YTD */}
          <View style={s.spyMetric}>
            <Text style={s.spyMetricLabel}>S&P 500 YTD</Text>
            <Text
              style={[s.spyMetricVal, { color: pctColor(spyPct) }]}
              adjustsFontSizeToFit
              numberOfLines={1}
            >
              {fmtPct(spyPct, 2)}
            </Text>
            <Text style={s.spyMetricSub}>SPY {isLive ? 'real-time' : 'stored'}</Text>
          </View>
          {/* Alpha */}
          {alpha != null && (
            <>
              <Text style={s.spyVs}>=</Text>
              <View style={[s.spyAlpha, alphaPos ? s.spyAlphaPos : s.spyAlphaNeg]}>
                <Text style={s.spyAlphaLabel}>ALPHA</Text>
                <Text
                  style={[s.spyAlphaVal, { color: alphaPos ? '#16A34A' : '#DC2626' }]}
                  adjustsFontSizeToFit
                  numberOfLines={1}
                >
                  {alphaPos ? '+' : ''}{alpha.toFixed(2)}%
                </Text>
                <Text style={s.spyAlphaSub}>{alphaPos ? 'outperforming' : 'underperforming'}</Text>
              </View>
            </>
          )}
        </View>
      </View>
    );
  }

  // ── Rebalance result table ──────────────────────────────────────────────
  // Renders current-weight → target-weight for the primary strategy.
  function RebalResultTable({ result, inputWeights, stratKey }) {
    const [tickerMeta, setTickerMeta] = useState({});

    if (!result?.strategies) return null;
    const key   = stratKey || result.primary_strategy || Object.keys(result.strategies)[0];
    const strat = result.strategies?.[key];
    // weights comes as a plain object { AAPL: 0.10, MSFT: 0.08, … } from the server
    const weightsObj = strat?.weights || {};
    const weightEntries = Object.entries(weightsObj).filter(([, w]) => w > 0);
    if (!weightEntries.length) return null;
    const weights = weightEntries
      .map(([ticker, target_weight]) => ({ ticker, target_weight }))
      .sort((a, b) => b.target_weight - a.target_weight);

    const iw = inputWeights || {};

    // Fetch sector + recent dev for each ticker (non-blocking, fills in as data arrives)
    useEffect(() => {
      let cancelled = false;
      const tickers = weights.map(w => w.ticker);
      Promise.allSettled(
        tickers.map(ticker =>
          api.getTickerMeta(ticker)
            .then(meta => {
              if (!cancelled && meta) {
                setTickerMeta(prev => ({ ...prev, [ticker]: meta }));
              }
            })
            .catch(() => {})
        )
      );
      return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [key, JSON.stringify(Object.keys(weightsObj).sort())]);

    return (
      <View style={s.rebalResultWrap}>
        <Text style={s.rebalResultTitle}>
          {(key || 'CURRENT').replace(/_/g, ' ').toUpperCase()}  ·  {weights.length} POSITIONS
        </Text>
        <ScrollView horizontal showsHorizontalScrollIndicator={false}>
          <View>
            <View style={[s.tableRow, s.tableHeader]}>
              <Text style={[s.th, { width: 50 }]}>Ticker</Text>
              <Text style={[s.th, s.thRight, { width: 46 }]}>Now</Text>
              <Text style={[s.th, { width: 18, textAlign: 'center' }]}> </Text>
              <Text style={[s.th, s.thRight, { width: 46 }]}>Target</Text>
              <Text style={[s.th, s.thRight, { width: 46 }]}>Δ</Text>
              <Text style={[s.th, { width: 80 }]}>Sector</Text>
              <Text style={[s.th, { width: 220 }]}>Recent Dev</Text>
            </View>
            {weights.map((w, i) => {
              const curRaw  = iw[w.ticker] != null ? iw[w.ticker] : null;
              const curPct  = curRaw != null ? curRaw * 100 : null;
              const tgtPct  = w.target_weight * 100;
              const delta   = curPct != null ? tgtPct - curPct : null;
              const dColor  = delta == null ? '#8090a8'
                            : delta > 0.5  ? '#16A34A'
                            : delta < -0.5 ? '#DC2626' : '#8090a8';
              const meta    = tickerMeta[w.ticker];
              const sector  = meta?.sector  || '…';
              const recentDev = meta?.recent_dev || '…';
              return (
                <View key={w.ticker} style={[s.tableRow, i % 2 === 1 && s.tableRowAlt]}>
                  <Text style={[s.td, { width: 50, color: colors.primary, fontWeight: '700' }]}>
                    {w.ticker}
                  </Text>
                  <Text style={[s.td, s.tdRight, s.tdDim, { width: 46 }]}>
                    {curPct != null ? curPct.toFixed(1) + '%' : '—'}
                  </Text>
                  <Text style={s.rebalArrow}>→</Text>
                  <Text style={[s.td, s.tdRight, s.tdBold, { width: 46 }]}>
                    {tgtPct.toFixed(1)}%
                  </Text>
                  <Text style={[s.td, s.tdRight, { width: 46, color: dColor }]}>
                    {delta == null ? '—' : (delta >= 0 ? '+' : '') + delta.toFixed(1) + '%'}
                  </Text>
                  <Text style={[s.td, s.rebalMeta, { width: 80 }]} numberOfLines={1}>
                    {sector}
                  </Text>
                  <Text style={[s.td, s.rebalDev, { width: 220 }]} numberOfLines={2}>
                    {recentDev}
                  </Text>
                </View>
              );
            })}
          </View>
        </ScrollView>
      </View>
    );
  }

  // ── Account Detail View ──────────────────────────────────────────────────
  function AccountDetailView() {
    const ov = acctOverview;
    const gainColor = (ov?.total_gain ?? 0) >= 0 ? '#c9a84c' : '#e05a4e';
    const ytdPct = ytdResult?.md_return_pct ?? null;
    const ytdColor = (ytdPct ?? 0) >= 0 ? '#c9a84c' : '#e05a4e';

    return (
      <View style={{ flex: 1 }}>
        {/* Back nav */}
        <View style={s.detailNavBar}>
          <TouchableOpacity style={s.backBtn} onPress={() => { setAcctDetailId(null); setAcctDetailName(''); }}>
            <Ionicons name="chevron-back" size={16} color={colors.primary} />
            <Text style={s.backBtnText}>All Accounts</Text>
          </TouchableOpacity>
          <Text style={s.detailNavTitle} numberOfLines={1}>{acctDetailName}</Text>
        </View>

        <ScrollView style={s.scroll} contentContainerStyle={s.scrollContent} showsVerticalScrollIndicator={false}>
          {acctLoadingDetail ? (
            <View style={s.center}>
              <ActivityIndicator color={colors.primary} size="large" />
              <Text style={s.loadingText}>Loading account…</Text>
            </View>
          ) : (
            <>
              {/* ── Overview stats ─────────────────────────────────────── */}
              {ov && (
                <View style={s.acctOverviewGrid}>
                  <View style={[s.acctStatCard, s.acctStatPrimary]}>
                    <Text style={s.acctStatLabel}>CURRENT VALUE</Text>
                    <Text style={s.acctStatValue}>{fmt$(ov.nav)}</Text>
                    {ytdPct != null
                      ? <Text style={[s.acctStatSub, { color: ytdColor }]}>{ytdPct >= 0 ? '+' : ''}{ytdPct.toFixed(2)}% YTD</Text>
                      : <Text style={[s.acctStatSub, { color: '#4a6080' }]}>YTD not calculated</Text>}
                  </View>
                  <View style={s.acctStatCard}>
                    <Text style={s.acctStatLabel}>TOTAL GAIN</Text>
                    <Text style={[s.acctStatValue, { fontSize: 17, color: gainColor }]}>{fmt$(ov.total_gain)}</Text>
                    <Text style={s.acctStatSub}>since {(ov.inception_date || '—').slice(0, 4)}</Text>
                  </View>
                  <View style={s.acctStatCard}>
                    <Text style={s.acctStatLabel}>POSITIONS</Text>
                    <Text style={[s.acctStatValue, { fontSize: 17 }]}>{ov.position_count ?? 0}</Text>
                    <Text style={s.acctStatSub}>open holdings</Text>
                  </View>
                  <View style={s.acctStatCard}>
                    <Text style={s.acctStatLabel}>MGMT FEE</Text>
                    <Text style={[s.acctStatValue, { fontSize: 17 }]}>{((ov.mgmt_fee_pct ?? 0) * 100).toFixed(1)}%</Text>
                    <Text style={s.acctStatSub}>annual advisory</Text>
                  </View>
                </View>
              )}

              {/* ── Section 1: Portfolio Positions ─────────────────────── */}
              <View style={s.fundSectionRow}>
                <Text style={s.sectionLabel}>PORTFOLIO POSITIONS</Text>
                <TouchableOpacity style={s.importBtn} onPress={() => pickCsv(async (f) => {
                  try {
                    await api.importPositions(acctDetailId, f.uri, f.name, f.mimeType);
                    const pos = await api.fundPositions(acctDetailId);
                    setAcctPositions(Array.isArray(pos) ? pos : []);
                    const ov2 = await api.fundOverview(acctDetailId);
                    setAcctOverview(ov2);
                  } catch (e) { Alert.alert('Import failed', e.message); }
                })}>
                  <Ionicons name="cloud-upload-outline" size={13} color={colors.primary} />
                  <Text style={s.importBtnText}>Import CSV</Text>
                </TouchableOpacity>
              </View>
              <View style={s.fundTableCard}>
                {acctPositions.length === 0 ? (
                  <Text style={s.emptyText}>No positions. Import a Fidelity Positions CSV above.</Text>
                ) : (
                  <>
                    <View style={s.posTableHead}>
                      <Text style={[s.posTh, { flex: 1.2, textAlign: 'left' }]}>SYMBOL</Text>
                      <Text style={s.posTh}>QTY</Text>
                      <Text style={s.posTh}>COST</Text>
                      <Text style={[s.posTh, { color: colors.primary }]}>MKT VAL</Text>
                      <Text style={s.posTh}>G/L</Text>
                    </View>
                    {acctPositions.map((p, i) => {
                      const gc = (p.unrealized_gain ?? 0) >= 0 ? '#4cc870' : '#e06050';
                      return (
                        <View key={p.symbol + i} style={[s.posTableRow, i > 0 && s.posTableBorder]}>
                          <View style={{ flex: 1.2 }}>
                            <Text style={s.posTicker}>{p.symbol}</Text>
                            <Text style={s.posName} numberOfLines={1}>{p.name || ''}</Text>
                          </View>
                          <Text style={s.posNum}>{Number(p.total_qty).toLocaleString()}</Text>
                          <Text style={s.posNum}>{fmt$(p.total_cost)}</Text>
                          <Text style={[s.posNum, { color: colors.primary }]}>{p.market_value != null ? fmt$(p.market_value) : '—'}</Text>
                          <Text style={[s.posNum, { color: gc }]}>{p.unrealized_gain != null ? fmt$(p.unrealized_gain) : '—'}</Text>
                        </View>
                      );
                    })}
                    {/* Total row */}
                    <View style={[s.posTableRow, s.posTotalRow]}>
                      <Text style={[s.posTicker, { color: '#6a8aaa', fontSize: 10, flex: 1.2 }]}>TOTAL</Text>
                      <Text style={s.posNum}></Text>
                      <Text style={s.posNum}>{fmt$(acctPositions.reduce((a, p) => a + (p.total_cost || 0), 0))}</Text>
                      <Text style={[s.posNum, { color: colors.primary, fontWeight: '700' }]}>{fmt$(acctPositions.reduce((a, p) => a + (p.market_value || 0), 0))}</Text>
                      <Text style={[s.posNum, { color: acctPositions.reduce((a, p) => a + (p.unrealized_gain || 0), 0) >= 0 ? '#4cc870' : '#e06050', fontWeight: '700' }]}>
                        {fmt$(acctPositions.reduce((a, p) => a + (p.unrealized_gain || 0), 0))}
                      </Text>
                    </View>
                  </>
                )}
              </View>

              {/* ── Section 2: Account History ─────────────────────────── */}
              <View style={s.fundSectionRow}>
                <Text style={s.sectionLabel}>ACCOUNT HISTORY</Text>
                <Text style={[s.importBtnText, { color: '#4a6080', fontSize: 10 }]}>from YTD calculation</Text>
              </View>
              <View style={s.fundTableCard}>
                {acctFlows.length === 0 ? (
                  <Text style={s.emptyText}>No cash flows. Run YTD Calculation below.</Text>
                ) : (
                  acctFlows.map((f, i) => {
                    const cls = f.amount >= 0 ? '#4cc870' : '#e06050';
                    const sign = f.amount >= 0 ? '+' : '−';
                    return (
                      <View key={i} style={[s.flowRow, i > 0 && s.flowBorder]}>
                        <Text style={s.flowDate}>{f.date}</Text>
                        <Text style={s.flowAction} numberOfLines={1}>{f.action}</Text>
                        <Text style={[s.flowAmt, { color: cls }]}>
                          {sign}${Math.round(Math.abs(f.amount)).toLocaleString('en-US', { maximumFractionDigits: 0 })}
                        </Text>
                      </View>
                    );
                  })
                )}
              </View>

              {/* ── Section 3: Investment Balance ─────────────────────────── */}
              {ytdResult && (
                <View style={s.ytdResultCard}>
                  <Text style={s.ytdSectionLabel}>INVESTMENT BALANCE · YTD PERFORMANCE</Text>
                  <View style={s.ytdMetricsRow}>
                    <View style={s.ytdMetric}>
                      <Text style={s.ytdMetricKey}>MD RETURN</Text>
                      <Text style={[s.ytdMetricVal, { color: pctColor(ytdResult.md_return_pct) }]}>
                        {fmtPct(ytdResult.md_return_pct, 2)}
                      </Text>
                    </View>
                    {ytdResult.twrr_return_pct != null && (
                      <View style={s.ytdMetric}>
                        <Text style={s.ytdMetricKey}>TWRR</Text>
                        <Text style={[s.ytdMetricVal, { color: pctColor(ytdResult.twrr_return_pct) }]}>
                          {fmtPct(ytdResult.twrr_return_pct, 2)}
                        </Text>
                      </View>
                    )}
                    <View style={s.ytdMetric}>
                      <Text style={s.ytdMetricKey}>TOTAL GAIN</Text>
                      <Text style={[s.ytdMetricVal, { color: pctColor(ytdResult.total_dollar_gain) }]}>
                        {fmt$0(ytdResult.total_dollar_gain)}
                      </Text>
                    </View>
                  </View>
                  <SpyComparisonCard portfolioPct={ytdResult.md_return_pct} />
                  {(ytdResult.attribution || []).length > 0 && (
                    <YtdAttribView items={ytdResult.attribution} portfolioReturn={ytdResult.md_return_pct ?? 0} />
                  )}
                </View>
              )}

              {/* ── Section 4: YTD Calculation ─────────────────────────── */}
              <View style={[s.ytdCard, { marginTop: 4 }]}>
                <View style={s.ytdCardHead}>
                  <Text style={s.ytdCardTitle}>COMPUTE YTD</Text>
                  <View style={s.ytdBadge}><Text style={s.ytdBadgeText}>MODIFIED DIETZ</Text></View>
                </View>
                <Text style={s.ytdCardDesc}>
                  Upload Fidelity CSVs to compute cash-flow adjusted returns with per-stock attribution.
                </Text>
                <FileRow label="Positions CSV" file={ytdPosFile} onPick={() => pickCsv(setYtdPosFile)} required />
                <FileRow label="Account History CSV" file={ytdActFile} onPick={() => pickCsv(setYtdActFile)} required />
                <FileRow label="Investment Balance CSV" file={ytdMonthlyFile} onPick={() => pickCsv(setYtdMonthlyFile)} />
                <View style={s.beginValueRow}>
                  <Text style={s.beginValueLabel}>Jan 1 Value (optional if balance CSV provided)</Text>
                  <TextInput
                    style={s.beginValueInput}
                    value={ytdBeginValue}
                    onChangeText={setYtdBeginValue}
                    placeholder="e.g. 250000"
                    placeholderTextColor="#3a5070"
                    keyboardType="numeric"
                  />
                </View>
                {ytdError ? <Text style={s.ytdError}>{ytdError}</Text> : null}
                <TouchableOpacity
                  style={[s.ytdBtn, ytdSubmitting && { opacity: 0.6 }]}
                  onPress={submitYtd}
                  disabled={ytdSubmitting}
                >
                  {ytdSubmitting
                    ? <ActivityIndicator color={colors.navy} size="small" />
                    : <Text style={s.ytdBtnText}>Calculate YTD &amp; Attribution</Text>}
                </TouchableOpacity>
              </View>
            </>
          )}
        </ScrollView>
      </View>
    );
  }

  // ── Account List View ─────────────────────────────────────────────────────
  function AccountListView() {
    return (
      <ScrollView style={s.scroll} contentContainerStyle={s.scrollContent} showsVerticalScrollIndicator={false}>
        {managedAccLoading ? (
          <View style={s.center}>
            <ActivityIndicator color={colors.primary} size="large" />
            <Text style={s.loadingText}>Loading accounts…</Text>
          </View>
        ) : managedAccList.length === 0 ? (
          <View style={s.fundListEmpty}>
            <Text style={s.fundListEmptyText}>No managed accounts yet.</Text>
            <Text style={s.fundListEmptyHint}>Use + Create New Account below to add one.</Text>
          </View>
        ) : (
          managedAccList.map(acc => {
            const accId = acc.id;
            const isRenaming = renamingId === accId;
            let ytdVal = acc.ytd_pct ?? null;
            const ytdColor2 = (ytdVal ?? 0) >= 0 ? '#c9a84c' : '#e05a4e';
            return (
              <View key={accId}>
                <TouchableOpacity
                  style={s.fundSummaryCard}
                  onPress={() => { if (!isRenaming) openAcctDetail(acc); }}
                  activeOpacity={0.8}
                >
                  <View style={s.fundSummaryHeader}>
                    <View style={{ flex: 1 }}>
                      <Text style={s.fundSummaryName}>{acc.name}</Text>
                      <Text style={s.fundSummaryShort}>{acc.short_name}  ·  est. {(acc.inception_date || '').slice(0, 4)}</Text>
                    </View>
                    <TouchableOpacity
                      onPress={() => isRenaming ? cancelRename() : startRename(acc)}
                      hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                      style={s.renameIconBtn}
                    >
                      <Text style={s.renameIconText}>{isRenaming ? '✕' : '✎'}</Text>
                    </TouchableOpacity>
                    <View style={s.fundSummaryStatusBadge}>
                      <Text style={s.fundSummaryStatusText}>ACTIVE</Text>
                    </View>
                  </View>
                  <View style={s.fundSummaryMetrics}>
                    <View style={s.fundSummaryMetric}>
                      <Text style={s.fundSummaryMetricLabel}>VALUE</Text>
                      <Text style={s.fundSummaryMetricValue}>{fmt$(acc.nav)}</Text>
                    </View>
                    <View style={s.fundSummaryMetric}>
                      <Text style={s.fundSummaryMetricLabel}>YTD</Text>
                      <Text style={[s.fundSummaryMetricValue, { color: ytdColor2 }]}>
                        {ytdVal != null ? `${ytdVal >= 0 ? '+' : ''}${ytdVal.toFixed(2)}%` : '—'}
                      </Text>
                    </View>
                    <View style={s.fundSummaryMetric}>
                      <Text style={s.fundSummaryMetricLabel}>POS</Text>
                      <Text style={s.fundSummaryMetricValue}>{acc.position_count || 0}</Text>
                    </View>
                    <View style={s.fundSummaryMetric}>
                      <Text style={s.fundSummaryMetricLabel}>FEE</Text>
                      <Text style={s.fundSummaryMetricValue}>{((acc.mgmt_fee_pct || 0) * 100).toFixed(1)}%</Text>
                    </View>
                  </View>
                  {!isRenaming && <Text style={s.fundSummaryCTA}>View Details →</Text>}
                </TouchableOpacity>
                {isRenaming && (
                  <View style={s.renameForm}>
                    <Text style={s.renameFormTitle}>RENAME ACCOUNT</Text>
                    <TextInput
                      style={s.renameInput}
                      value={renameNameVal}
                      onChangeText={setRenameNameVal}
                      placeholder="Full account name"
                      placeholderTextColor="#3a5070"
                      autoFocus
                    />
                    <TextInput
                      style={s.renameInput}
                      value={renameShortVal}
                      onChangeText={v => setRenameShortVal(v.toUpperCase())}
                      placeholder="SHORT-CODE"
                      placeholderTextColor="#3a5070"
                      maxLength={12}
                      autoCapitalize="characters"
                    />
                    {renameMsg && (
                      <Text style={{ color: renameMsg.ok ? '#4cc870' : '#e05a4e', fontSize: 12, marginBottom: 8 }}>
                        {renameMsg.text}
                      </Text>
                    )}
                    <View style={{ flexDirection: 'row', gap: 8 }}>
                      <TouchableOpacity
                        style={[s.importBtn2, { flex: 1, backgroundColor: colors.primary }]}
                        onPress={() => submitRename(accId)}
                        disabled={renameBusy}
                      >
                        {renameBusy
                          ? <ActivityIndicator color={colors.navy} size="small" />
                          : <Text style={[s.importBtn2Text, { color: colors.navy }]}>Save</Text>}
                      </TouchableOpacity>
                      <TouchableOpacity style={[s.importBtn2, { flex: 1 }]} onPress={cancelRename}>
                        <Text style={s.importBtn2Text}>Cancel</Text>
                      </TouchableOpacity>
                    </View>
                  </View>
                )}
              </View>
            );
          })
        )}

        {/* Create New Account form */}
        <View style={{ paddingHorizontal: 16, marginTop: 8 }}>
          {!showCreateAcct ? (
            <TouchableOpacity style={s.importBtn2} onPress={() => setShowCreateAcct(true)}>
              <Text style={s.importBtn2Text}>+ Create New Account</Text>
            </TouchableOpacity>
          ) : (
            <View style={s.createFundForm}>
              <Text style={s.createFundTitle}>New Managed Account</Text>
              <TextInput style={s.createFundInput} value={newAcctName} onChangeText={setNewAcctName}
                placeholder="Account Name (e.g. Smith Family Brokerage)" placeholderTextColor="#3a5070" />
              <TextInput style={s.createFundInput} value={newAcctShort} onChangeText={setNewAcctShort}
                placeholder="Short Name (e.g. SMITH-1)" placeholderTextColor="#3a5070" />
              <TextInput style={s.createFundInput} value={newAcctInception} onChangeText={setNewAcctInception}
                placeholder="Inception Date (YYYY-MM-DD or YYYY)" placeholderTextColor="#3a5070" />
              <TextInput style={s.createFundInput} value={newAcctFee} onChangeText={setNewAcctFee}
                placeholder="Mgmt Fee % (e.g. 1)" placeholderTextColor="#3a5070" keyboardType="numeric" />
              {createAcctStatus && (
                <Text style={{ color: createAcctStatus.ok ? '#4cc870' : '#e05a4e', fontSize: 12, marginBottom: 8 }}>
                  {createAcctStatus.msg}
                </Text>
              )}
              <View style={{ flexDirection: 'row', gap: 8 }}>
                <TouchableOpacity style={[s.importBtn2, { flex: 1, backgroundColor: colors.primary }]}
                  onPress={submitCreateAccount} disabled={createAcctBusy}>
                  {createAcctBusy
                    ? <ActivityIndicator color={colors.navy} size="small" />
                    : <Text style={[s.importBtn2Text, { color: colors.navy }]}>Create Account</Text>}
                </TouchableOpacity>
                <TouchableOpacity style={[s.importBtn2, { flex: 1 }]} onPress={() => { setShowCreateAcct(false); setCreateAcctStatus(null); }}>
                  <Text style={s.importBtn2Text}>Cancel</Text>
                </TouchableOpacity>
              </View>
            </View>
          )}
        </View>
      </ScrollView>
    );
  }

  function MyPortfolioPanel() {
    if (acctDetailId) return <AccountDetailView />;
    return <AccountListView />;
  }

  // ── Rebalanced branch panel ──────────────────────────────────────────────
  // Shows all three strategy tables from the last portfolio run.
  function RebalancedPanel() {
    const data = rebalJob?.status === 'done' ? rebalJob : lastRebal;

    if (!data?.result?.strategies) {
      return (
        <View style={s.rebalEmptyWrap}>
          <Text style={s.rebalEmptyIcon}>📊</Text>
          <Text style={s.rebalEmptyTitle}>No Rebalance Data</Text>
          <Text style={s.rebalEmptyDesc}>
            Run a portfolio rebalance from the Managed Account tab.{'\n'}
            Results will appear here for all three strategies.
          </Text>
        </View>
      );
    }

    const result       = data.result;
    const inputWeights = data.input_weights || {};
    const primary      = result.primary_strategy;
    const stratKeys    = [primary, ...Object.keys(result.strategies || {}).filter(k => k !== primary)];
    const emailOk      = result.email?.ok;
    const emailSent    = result.email && !result.email.skipped;
    const sentTo       = result.email?.sent_to || '';
    const runAt        = data.completed_at
      ? new Date(data.completed_at).toLocaleString('en-US', {
          month: 'short', day: 'numeric', year: 'numeric',
          hour: 'numeric', minute: '2-digit',
        })
      : '—';

    return (
      <View style={s.rebalBranchWrap}>
        {/* Header */}
        <View style={s.rebalBranchHeader}>
          <View>
            <Text style={s.rebalBranchTitle}>PORTFOLIO REBALANCE</Text>
            <Text style={s.rebalBranchMeta}>
              {runAt}{data.n_tickers ? `  ·  ${data.n_tickers} tickers` : ''}
            </Text>
          </View>
          {/* Email status badge */}
          {emailSent && (
            <View style={[s.rebalEmailBadge, emailOk ? s.rebalEmailOk : s.rebalEmailFail]}>
              <Text style={s.rebalEmailBadgeText}>
                {emailOk ? `📧 Emailed${sentTo ? ` ${sentTo}` : ''}` : '📧 Email failed'}
              </Text>
            </View>
          )}
        </View>

        {/* One table per strategy */}
        {stratKeys.map(k => {
          const strat = result.strategies?.[k];
          if (!strat) return null;
          const label = (strat.label || k).toUpperCase();
          const isPrimary = k === primary;
          return (
            <View key={k} style={[s.rebalStratBlock, isPrimary && s.rebalStratBlockPrimary]}>
              <View style={s.rebalStratLabelRow}>
                <Text style={s.rebalStratLabel}>{label}</Text>
                {isPrimary && <Text style={s.rebalStratPrimaryBadge}>PRIMARY</Text>}
                <Text style={s.rebalStratCount}>{strat.held || 0} positions</Text>
              </View>
              <RebalResultTable result={result} inputWeights={inputWeights} stratKey={k} />
            </View>
          );
        })}

        {/* Download button */}
        {data.job_id && (
          <TouchableOpacity
            style={[s.rebalRunBtn, { marginHorizontal: 0, marginTop: 16 }]}
            onPress={() => {
              const fn = data === rebalJob ? openRebalDownload : openLastRebalDownload;
              fn();
            }}
          >
            <Ionicons name="download-outline" size={15} color={colors.navy} style={{ marginRight: 6 }} />
            <Text style={s.rebalRunBtnText}>Download DGA-portfolio.xlsx</Text>
          </TouchableOpacity>
        )}
      </View>
    );
  }

  // ── LP Fund panels ───────────────────────────────────────────────────────
  function OverviewPanel() {
    if (!overview) return null;
    const gainColor = overview.total_gain >= 0 ? colors.primary : '#e05a4e';
    return (
      <View style={s.overviewWrap}>
        <View style={s.heroCard}>
          <Text style={s.heroLabel}>CURRENT NAV</Text>
          <Text style={s.heroValue} adjustsFontSizeToFit minimumFontScale={0.7} numberOfLines={1}>{fmt$(overview.nav)}</Text>
          <Text style={[s.heroGain, { color: gainColor }]}>
            {fmtPct(overview.gain_pct)} since inception ({overview.inception_date?.slice(0,4)})
          </Text>
        </View>
        <View style={s.statRow}>
          <View style={s.statCard}>
            <Text style={s.statLabel}>CONTRIBUTIONS</Text>
            <Text style={s.statValue}>{fmt$(overview.contributions)}</Text>
            <Text style={s.statSub}>{overview.lp_count} LPs</Text>
          </View>
          <View style={s.statCard}>
            <Text style={s.statLabel}>TOTAL GAIN</Text>
            <Text style={[s.statValue, { color: gainColor }]}>{fmt$(overview.total_gain)}</Text>
            <Text style={s.statSub}>inception to date</Text>
          </View>
          <View style={s.statCard}>
            <Text style={s.statLabel}>POSITIONS</Text>
            <Text style={s.statValue}>{overview.position_count}</Text>
            <Text style={s.statSub}>securities</Text>
          </View>
        </View>
        <View style={s.econCard}>
          <Text style={s.econTitle}>FUND ECONOMICS</Text>
          <View style={s.econRow}>
            <EconPill label="Mgmt Fee" value={`${(overview.mgmt_fee_pct * 100).toFixed(0)}%`} />
            <EconPill label="Carry"    value={`${(overview.carry_pct   * 100).toFixed(0)}%`} gold />
            <EconPill label="Hurdle"   value={`${(overview.hurdle_pct  * 100).toFixed(0)}%/yr`} />
            {overview.catch_up_pct != null && (
              <EconPill label="Catch-up" value={`${(overview.catch_up_pct * 100).toFixed(0)}%`} />
            )}
          </View>
        </View>
      </View>
    );
  }

  function EconPill({ label, value, gold }) {
    return (
      <View style={[s.econPill, gold && s.econPillGold]}>
        <Text style={[s.econPillVal, gold && { color: colors.navy }]}>{value}</Text>
        <Text style={[s.econPillLbl, gold && { color: colors.navy + 'cc' }]}>{label}</Text>
      </View>
    );
  }

  function LPsPanel() {
    const lpOnly = lps.filter(l => l.commitment > 0);
    return (
      <View>
        {/* Import cap table button */}
        <View style={s.importRow}>
          <TouchableOpacity
            style={[s.importBtn, importCtLoading && s.importBtnDisabled]}
            onPress={importCaptable}
            disabled={importCtLoading}
            activeOpacity={0.7}
          >
            <Text style={s.importBtnText}>
              {importCtLoading ? '⏳ Importing…' : '↑ Import Cap Table'}
            </Text>
          </TouchableOpacity>
          {importCtStatus && (
            <Text style={[s.importStatus, importCtStatus.ok ? s.importStatusOk : s.importStatusErr]}>
              {importCtStatus.msg}
            </Text>
          )}
        </View>
        {!lpOnly.length ? (
          <Text style={s.emptyText}>No LP records found.</Text>
        ) : (
      <View style={s.tableWrap}>
        <View style={[s.tableRow, s.tableHeader]}>
          <Text style={[s.th, { flex: 1.4 }]}>LP</Text>
          <Text style={[s.th, s.thRight]}>Committed</Text>
          <Text style={[s.th, s.thRight]}>Gain</Text>
          <Text style={[s.th, s.thRight]}>Value</Text>
          <Text style={[s.th, s.thRight, { flex: 0.6 }]}>%</Text>
        </View>
        {lpOnly.map((lp, i) => (
          <View key={lp.id} style={[s.tableRow, i % 2 === 1 && s.tableRowAlt]}>
            <Text style={[s.td, { flex: 1.4 }]} numberOfLines={1}>{lp.legal_name}</Text>
            <Text style={[s.td, s.tdRight]}>{fmt$(lp.commitment)}</Text>
            <Text style={[s.td, s.tdRight, { color: colors.primary }]}>{fmt$(lp.gain)}</Text>
            <Text style={[s.td, s.tdRight, s.tdBold]}>{fmt$(lp.current_value)}</Text>
            <Text style={[s.td, s.tdRight, s.tdDim, { flex: 0.6 }]}>{lp.share_pct.toFixed(0)}%</Text>
          </View>
        ))}
        <View style={[s.tableRow, s.totalsRow]}>
          <Text style={[s.td, s.tdBold, { flex: 1.4 }]}>Total</Text>
          <Text style={[s.td, s.tdRight, s.tdBold]}>{fmt$(lpOnly.reduce((a,l) => a + l.commitment, 0))}</Text>
          <Text style={[s.td, s.tdRight, { color: colors.primary, fontWeight:'700' }]}>{fmt$(lpOnly.reduce((a,l) => a + l.gain, 0))}</Text>
          <Text style={[s.td, s.tdRight, s.tdBold]}>{fmt$(lpOnly.reduce((a,l) => a + l.current_value, 0))}</Text>
          <Text style={[s.td, s.tdRight, s.tdDim, { flex: 0.6 }]}>100%</Text>
        </View>
      </View>
        )}
      </View>
    );
  }

  function PositionsPanel() {
    const totalMktVal = positions.reduce((s, p) => s + (p.market_value || 0), 0);
    return (
      <View>
        {/* Import button row */}
        <View style={s.importRow}>
          <TouchableOpacity
            style={[s.importBtn, importPosLoading && s.importBtnDisabled]}
            onPress={importPositions}
            disabled={importPosLoading}
            activeOpacity={0.7}
          >
            <Text style={s.importBtnText}>
              {importPosLoading ? '⏳ Importing…' : '↑ Import Positions'}
            </Text>
          </TouchableOpacity>
          {importPosStatus && (
            <Text style={[s.importStatus, importPosStatus.ok ? s.importStatusOk : s.importStatusErr]}>
              {importPosStatus.msg}
            </Text>
          )}
        </View>

        {!positions.length ? (
          <Text style={s.emptyText}>No open positions.</Text>
        ) : (
          <ScrollView horizontal showsHorizontalScrollIndicator={false}>
            <View style={s.tableWrap}>
              <View style={[s.tableRow, s.tableHeader]}>
                <Text style={[s.th, { width: 64 }]}>Symbol</Text>
                <Text style={[s.th, s.thRight, { width: 56 }]}>Qty</Text>
                <Text style={[s.th, s.thRight, { width: 64 }]}>Avg $</Text>
                <Text style={[s.th, s.thRight, { width: 72 }]}>Cost</Text>
                <Text style={[s.th, s.thRight, { width: 64, color: '#5BB8D4' }]}>Last $</Text>
                <Text style={[s.th, s.thRight, { width: 80, color: '#5BB8D4' }]}>Mkt Val</Text>
                <Text style={[s.th, s.thRight, { width: 72 }]}>P/L</Text>
                <Text style={[s.th, s.thRight, { width: 48 }]}>Wt%</Text>
              </View>
              {positions.map((p, i) => {
                const hasMkt   = p.market_value != null;
                const plColor  = (p.unrealized_gain || 0) >= 0 ? '#4cc870' : '#e06050';
                const mktWt    = p.market_weight_pct != null ? p.market_weight_pct.toFixed(1) + '%' : '—';
                return (
                  <View key={p.symbol + i} style={[s.tableRow, i % 2 === 1 && s.tableRowAlt]}>
                    <View style={[{ width: 64 }, s.symbolCell]}>
                      <Text style={s.symbolText}>{p.symbol}</Text>
                      {p.lot_count > 1 && <Text style={s.lotBadge}>{p.lot_count}L</Text>}
                    </View>
                    <Text style={[s.td, s.tdRight, { width: 56 }]}>{Number(p.total_qty).toLocaleString()}</Text>
                    <Text style={[s.td, s.tdRight, { width: 64 }]}>${Math.round(p.avg_cost).toLocaleString('en-US')}</Text>
                    <Text style={[s.td, s.tdRight, { width: 72 }]}>{fmt$(p.total_cost)}</Text>
                    <Text style={[s.td, s.tdRight, { width: 64, color: '#5BB8D4' }]}>
                      {hasMkt ? `$${p.last_price?.toFixed(2)}` : '—'}
                    </Text>
                    <Text style={[s.td, s.tdRight, s.tdBold, { width: 80, color: hasMkt ? '#5BB8D4' : '#b0bdd0' }]}>
                      {hasMkt ? fmt$(p.market_value) : '—'}
                    </Text>
                    <Text style={[s.td, s.tdRight, { width: 72, color: hasMkt ? plColor : '#4a6080' }]}>
                      {hasMkt ? fmt$(p.unrealized_gain) : '—'}
                    </Text>
                    <Text style={[s.td, s.tdRight, s.tdDim, { width: 48 }]}>{mktWt}</Text>
                  </View>
                );
              })}
              {/* Total footer */}
              {totalMktVal > 0 && (
                <View style={[s.tableRow, { borderTopWidth: 1, borderTopColor: 'rgba(91,184,212,0.2)' }]}>
                  <Text style={[s.td, { width: 64, color: '#4a6080', fontSize: 9, fontWeight: '700' }]}>TOTAL</Text>
                  <Text style={[s.td, s.tdRight, { width: 56 }]}></Text>
                  <Text style={[s.td, s.tdRight, { width: 64 }]}></Text>
                  <Text style={[s.td, s.tdRight, s.tdBold, { width: 72 }]}>
                    {fmt$(positions.reduce((acc, p) => acc + (p.total_cost || 0), 0))}
                  </Text>
                  <Text style={[s.td, s.tdRight, { width: 64 }]}></Text>
                  <Text style={[s.td, s.tdRight, s.tdBold, { width: 80, color: '#5BB8D4' }]}>
                    {fmt$(totalMktVal)}
                  </Text>
                  <Text style={[s.td, s.tdRight, { width: 72,
                    color: positions.reduce((acc, p) => acc + (p.unrealized_gain || 0), 0) >= 0 ? '#4cc870' : '#e06050' }]}>
                    {fmt$(positions.reduce((acc, p) => acc + (p.unrealized_gain || 0), 0))}
                  </Text>
                  <Text style={[s.td, s.tdRight, { width: 48 }]}></Text>
                </View>
              )}
            </View>
          </ScrollView>
        )}
      </View>
    );
  }

  function ActivityPanel() {
    if (!activity.length) return <Text style={s.emptyText}>No transactions.</Text>;
    return (
      <View style={s.activityWrap}>
        {activity.map((a) => (
          <View key={a.id} style={s.activityRow}>
            <View style={s.activityLeft}>
              <View style={[s.catPill, catPillStyle(a.category)]}>
                <Text style={[s.catPillText, catPillTextStyle(a.category)]}>{fmtCat(a.category)}</Text>
              </View>
              <Text style={s.actDesc} numberOfLines={2}>{a.description}</Text>
            </View>
            <View style={s.activityRight}>
              <Text style={s.actAmount}>{fmt$(a.amount)}</Text>
              <Text style={s.actDate}>{a.effective_date}</Text>
            </View>
          </View>
        ))}
      </View>
    );
  }

  function WaterfallPanel() {
    if (!waterfall) return <Text style={s.emptyText}>No waterfall data.</Text>;
    const w         = waterfall;
    const cPct      = (w.carry_pct * 100).toFixed(0);
    const isApprox  = w.data_source === 'approximation';
    const gpPct     = w.gp_equity_pct != null ? w.gp_equity_pct.toFixed(2) + '%' : '—';
    const carryYrs  = (w.carry_years || []).join(', ') || 'None';
    const curCarryNote = w.cur_year_new_carry > 0
      ? ` + ${fmt$(w.cur_year_new_carry)} est.`
      : '';

    return (
      <View style={s.wfallWrap}>
        {isApprox && (
          <View style={s.wfallWarn}>
            <Text style={s.wfallWarnText}>
              ⚠ Approximate — annual NAV snapshots not yet entered.
              Figures use simple hurdle × {w.years_since_inception?.toFixed(1)} yrs.
            </Text>
          </View>
        )}

        {/* Summary card */}
        <View style={s.wfallCard}>
          <WRow label="Structure"
                value={`$100K/yr hurdle · ${cPct}% carry above HWM`} />
          <WRow label="Total fund gain"
                value={fmt$(w.total_gain)} />
          <WRow label="High-watermark"
                value={fmt$(w.high_watermark)} />
          <WRow label={`Years carry earned`}
                value={carryYrs} />
          <WRow label={`GP equity (${gpPct}${curCarryNote})`}
                value={fmt$(w.gp_accrued_carry)} valueColor="#e8a060" highlight />
          <WRow label="LP net value (after carry)"
                value={fmt$(w.lp_nav_after_carry)} valueColor={colors.primary} highlight />
          <WRow label="Total fund NAV"
                value={fmt$(w.nav)} last />
        </View>

        {/* Year-by-year table */}
        {(w.annual_snapshots || []).length > 0 && (
          <>
            <Text style={s.wfallSubhead}>YEAR-BY-YEAR</Text>
            <View style={s.tableWrap}>
              <View style={[s.tableRow, s.tableHeader]}>
                <Text style={[s.th, { flex: 0.55 }]}>Yr</Text>
                <Text style={[s.th, s.thRight]}>Profit</Text>
                <Text style={[s.th, s.thRight]}>HWM</Text>
                <Text style={[s.th, s.thRight]}>Carry</Text>
                <Text style={[s.th, s.thRight]}>GP $</Text>
                <Text style={[s.th, s.thRight, { flex: 0.7 }]}>GP %</Text>
              </View>
              {w.annual_snapshots.map((snap, i) => {
                const carryColor = snap.carry_earned > 0 ? '#e8a060' : '#3a5070';
                return (
                  <View key={snap.year} style={[s.tableRow, i % 2 === 1 && s.tableRowAlt]}>
                    <Text style={[s.td, { flex: 0.55, color: colors.primary, fontWeight:'700' }]}>{snap.year}</Text>
                    <Text style={[s.td, s.tdRight, { color: snap.gross_profit >= 0 ? '#a0b890' : '#e06050' }]}>
                      {fmt$(snap.gross_profit)}
                    </Text>
                    <Text style={[s.td, s.tdRight, s.tdDim]}>{fmt$(snap.hwm_threshold)}</Text>
                    <Text style={[s.td, s.tdRight, { color: carryColor, fontWeight: snap.carry_earned > 0 ? '700' : '400' }]}>
                      {snap.carry_earned > 0 ? fmt$(snap.carry_earned) : '—'}
                    </Text>
                    <Text style={[s.td, s.tdRight, { color: '#e8a060', fontWeight: '700' }]}>
                      {fmt$(snap.gp_equity_end)}
                    </Text>
                    <Text style={[s.td, s.tdRight, { color: '#e8a060', flex: 0.7 }]}>
                      {snap.accum_gp_pct != null ? snap.accum_gp_pct.toFixed(2) + '%' : '—'}
                    </Text>
                  </View>
                );
              })}
            </View>
          </>
        )}

        {/* Per-LP table */}
        <Text style={s.wfallSubhead}>PER-LP AFTER CARRY</Text>
        <View style={s.tableWrap}>
          <View style={[s.tableRow, s.tableHeader]}>
            <Text style={[s.th, { flex: 1 }]}>LP</Text>
            <Text style={[s.th, s.thRight]}>GP Carry −</Text>
            <Text style={[s.th, s.thRight]}>Net Value</Text>
          </View>
          {(w.per_lp || []).map((lp, i) => (
            <View key={lp.legal_name} style={[s.tableRow, i % 2 === 1 && s.tableRowAlt]}>
              <Text style={[s.td, { flex: 1 }]} numberOfLines={1}>{lp.legal_name}</Text>
              <Text style={[s.td, s.tdRight, { color: '#e06050' }]}>−{fmt$(lp.carry_charge)}</Text>
              <Text style={[s.td, s.tdRight, s.tdBold, { color: colors.primary }]}>{fmt$(lp.nav_after_carry)}</Text>
            </View>
          ))}
        </View>
      </View>
    );
  }

  function WRow({ label, value, valueColor, highlight, last }) {
    return (
      <View style={[s.wRow, highlight && s.wRowHighlight, last && s.wRowLast]}>
        <Text style={s.wLabel}>{label}</Text>
        <Text style={[s.wValue, valueColor && { color: valueColor }]}>{value}</Text>
      </View>
    );
  }

  function catPillStyle(cat) {
    const m = { contribution:'rgba(50,160,80,.18)', trade_buy:'rgba(80,120,201,.18)', trade_sell:'rgba(220,80,60,.18)', adjustment:'rgba(91,184,212,.18)', transfer:'rgba(140,80,201,.18)' };
    return { backgroundColor: m[cat] || 'rgba(255,255,255,0.07)' };
  }
  function catPillTextStyle(cat) {
    const m = { contribution:'#4cc870', trade_buy:'#6090e8', trade_sell:'#e06050', adjustment:'#5BB8D4', transfer:'#b080e8' };
    return { color: m[cat] || '#8090a8' };
  }

  // ── Fund List View ───────────────────────────────────────────────────────
  function FundListView() {
    if (fundListLoading) {
      return (
        <View style={s.center}>
          <ActivityIndicator color={colors.primary} size="large" />
          <Text style={s.loadingText}>Loading funds…</Text>
        </View>
      );
    }
    if (fundListError) {
      return (
        <View style={s.center}>
          <Text style={s.errorText}>{fundListError}</Text>
          <TouchableOpacity style={s.retryBtn} onPress={loadFundList}>
            <Text style={s.retryText}>Retry</Text>
          </TouchableOpacity>
        </View>
      );
    }
    if (!fundList.length) {
      return (
        <View style={s.center}>
          <Text style={s.emptyText}>No funds found in database.</Text>
          <TouchableOpacity style={s.retryBtn} onPress={loadFundList}>
            <Text style={s.retryText}>Refresh</Text>
          </TouchableOpacity>
        </View>
      );
    }
    return (
      <ScrollView
        style={s.scroll}
        contentContainerStyle={[s.scrollContent, { padding: 14 }]}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} />}
        showsVerticalScrollIndicator={false}
      >
        <Text style={s.fundListHint}>Select a fund to view details</Text>
        {fundList.map((fund) => {
          const isRenaming = renamingId === fund.id;
          const gainColor = fund.total_gain >= 0 ? colors.primary : '#e05a4e';
          const statusColor = fund.status === 'active' ? '#4cc870' : '#6a8aaa';
          return (
            <View key={fund.id}>
            <TouchableOpacity
              style={s.fundCard}
              onPress={() => { if (!isRenaming) openFundDetail(fund); }}
              activeOpacity={0.82}
            >
              {/* Fund name + status badge */}
              <View style={s.fundCardHeader}>
                <View style={{ flex: 1 }}>
                  <Text style={s.fundCardName} numberOfLines={1}>{fund.name}</Text>
                  <Text style={s.fundCardShort}>{fund.short_name}  ·  est. {fund.inception_date?.slice(0, 4)}</Text>
                </View>
                <TouchableOpacity
                  onPress={() => isRenaming ? cancelRename() : startRename(fund)}
                  hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                  style={s.renameIconBtn}
                >
                  <Text style={s.renameIconText}>{isRenaming ? '✕' : '✎'}</Text>
                </TouchableOpacity>
                <View style={[s.fundStatusBadge, { borderColor: statusColor }]}>
                  <Text style={[s.fundStatusText, { color: statusColor }]}>
                    {(fund.status || 'active').toUpperCase()}
                  </Text>
                </View>
              </View>

              {/* Key metrics row */}
              <View style={s.fundCardMetrics}>
                <View style={s.fundCardMetric}>
                  <Text style={s.fundCardMetricLabel}>NAV</Text>
                  <Text style={s.fundCardMetricValue}>{fmt$(fund.nav)}</Text>
                </View>
                <View style={s.fundCardMetric}>
                  <Text style={s.fundCardMetricLabel}>GAIN</Text>
                  <Text style={[s.fundCardMetricValue, { color: gainColor }]}>
                    {fmtPct(fund.gain_pct)}
                  </Text>
                </View>
                <View style={s.fundCardMetric}>
                  <Text style={s.fundCardMetricLabel}>LPs</Text>
                  <Text style={s.fundCardMetricValue}>{fund.lp_count}</Text>
                </View>
                <View style={s.fundCardMetric}>
                  <Text style={s.fundCardMetricLabel}>ECONOMICS</Text>
                  <Text style={s.fundCardMetricValue}>
                    {(fund.mgmt_fee_pct * 100).toFixed(0)}/{(fund.carry_pct * 100).toFixed(0)}
                  </Text>
                </View>
              </View>

              {/* CTA */}
              {!isRenaming && (
                <View style={s.fundCardCta}>
                  <Text style={s.fundCardCtaText}>View Details →</Text>
                </View>
              )}
            </TouchableOpacity>
            {isRenaming && (
              <View style={s.renameForm}>
                <Text style={s.renameFormTitle}>RENAME FUND</Text>
                <TextInput
                  style={s.renameInput}
                  value={renameNameVal}
                  onChangeText={setRenameNameVal}
                  placeholder="Full fund name"
                  placeholderTextColor="#3a5070"
                  autoFocus
                />
                <TextInput
                  style={s.renameInput}
                  value={renameShortVal}
                  onChangeText={v => setRenameShortVal(v.toUpperCase())}
                  placeholder="SHORT-CODE"
                  placeholderTextColor="#3a5070"
                  maxLength={12}
                  autoCapitalize="characters"
                />
                {renameMsg && (
                  <Text style={{ color: renameMsg.ok ? '#4cc870' : '#e05a4e', fontSize: 12, marginBottom: 8 }}>
                    {renameMsg.text}
                  </Text>
                )}
                <View style={{ flexDirection: 'row', gap: 8 }}>
                  <TouchableOpacity
                    style={[s.importBtn2, { flex: 1, backgroundColor: colors.primary }]}
                    onPress={() => submitRename(fund.id)}
                    disabled={renameBusy}
                  >
                    {renameBusy
                      ? <ActivityIndicator color={colors.navy} size="small" />
                      : <Text style={[s.importBtn2Text, { color: colors.navy }]}>Save</Text>}
                  </TouchableOpacity>
                  <TouchableOpacity style={[s.importBtn2, { flex: 1 }]} onPress={cancelRename}>
                    <Text style={s.importBtn2Text}>Cancel</Text>
                  </TouchableOpacity>
                </View>
              </View>
            )}
            </View>
          );
        })}
      </ScrollView>
    );
  }

  // ── Main render ──────────────────────────────────────────────────────────
  return (
    <View style={s.screen}>
      <AppHeader
        title="Fund Admin"
        subtitle={activeFundId ? activeFundName : 'DGA Capital'}
      />

      {/* Top branch selector */}
      <View style={s.branchBar}>
        {BRANCHES.map(b => (
          <TouchableOpacity
            key={b}
            style={[s.branchBtn, branch === b && s.branchBtnActive]}
            onPress={() => {
              setBranch(b);
              if (b === 'LP Fund') {
                if (activeFundId) closeFundDetail();
              }
              if (b === 'Managed Account') {
                loadYtdSnapshots();
                loadManagedAccList(activeManagedAccId);
              }
              // 'Rebalanced' uses lastRebal already loaded by useFocusEffect — no extra fetch needed
            }}
          >
            <Text style={[s.branchBtnText, branch === b && s.branchBtnTextActive]}>{b}</Text>
          </TouchableOpacity>
        ))}
      </View>

      {branch === 'Rebalanced' ? (
        <ScrollView
          style={s.scroll}
          contentContainerStyle={s.scrollContent}
          showsVerticalScrollIndicator={false}
        >
          <RebalancedPanel />
        </ScrollView>
      ) : branch === 'Managed Account' ? (
        <KeyboardAvoidingView
          style={{ flex: 1 }}
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          keyboardVerticalOffset={Platform.OS === 'ios' ? 64 : 0}
        >
          <ScrollView
            style={s.scroll}
            contentContainerStyle={s.scrollContent}
            showsVerticalScrollIndicator={false}
            keyboardShouldPersistTaps="handled"
          >
            <MyPortfolioPanel />
          </ScrollView>
        </KeyboardAvoidingView>
      ) : activeFundId ? (
        /* ── Fund Detail View (sub-tabs) ─────────────────────────────── */
        <>
          {/* Back button + sub-tabs */}
          <View style={s.detailNavBar}>
            <TouchableOpacity style={s.backBtn} onPress={closeFundDetail}>
              <Ionicons name="chevron-back" size={16} color={colors.primary} />
              <Text style={s.backBtnText}>All Funds</Text>
            </TouchableOpacity>
          </View>

          <View style={s.subTabBar}>
            {LP_TABS.map(tab => (
              <TouchableOpacity
                key={tab}
                style={[s.subTab, activeTab === tab && s.subTabActive]}
                onPress={() => setActiveTab(tab)}
              >
                <Text style={[s.subTabText, activeTab === tab && s.subTabTextActive]}>{tab}</Text>
              </TouchableOpacity>
            ))}
          </View>

          {loading && !refreshing ? (
            <View style={s.center}>
              <ActivityIndicator color={colors.primary} size="large" />
              <Text style={s.loadingText}>Loading fund data…</Text>
            </View>
          ) : error ? (
            <View style={s.center}>
              <Text style={s.errorText}>{error}</Text>
              <TouchableOpacity style={s.retryBtn} onPress={() => loadData(false, activeFundId)}>
                <Text style={s.retryText}>Retry</Text>
              </TouchableOpacity>
            </View>
          ) : (
            <ScrollView style={s.scroll} contentContainerStyle={s.scrollContent}
              refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} />}
              showsVerticalScrollIndicator={false}
            >
              {activeTab === 'Overview'  && <OverviewPanel />}
              {activeTab === 'LPs'       && <LPsPanel />}
              {activeTab === 'Positions' && <PositionsPanel />}
              {activeTab === 'Activity'  && <ActivityPanel />}
              {activeTab === 'Waterfall' && <WaterfallPanel />}
            </ScrollView>
          )}
        </>
      ) : (
        /* ── Fund List View ──────────────────────────────────────────── */
        <FundListView />
      )}
    </View>
  );
}

// ── YTD sub-components (outside FundScreen for perf) ─────────────────────────
function YtdAttribView({ items, portfolioReturn }) {
  if (!items.length) return null;
  const haveContrib = items.some(h => h.contribution_pct != null);
  if (!haveContrib) return null;
  const sorted  = [...items].sort((a, b) => (b.contribution_pct ?? -999) - (a.contribution_pct ?? -999));
  const maxAbs  = Math.max(...sorted.map(h => Math.abs(h.contribution_pct ?? 0)), 0.01);
  const retColor = portfolioReturn >= 0 ? '#16A34A' : '#DC2626';
  return (
    <View style={as.wrap}>
      <View style={as.summaryRow}>
        <View style={[as.pill, { backgroundColor: portfolioReturn >= 0 ? 'rgba(22,163,74,0.12)' : 'rgba(220,38,38,0.12)' }]}>
          <Text style={[as.pillText, { color: retColor }]}>
            Portfolio: {portfolioReturn >= 0 ? '+' : ''}{portfolioReturn.toFixed(2)}%
          </Text>
        </View>
        <Text style={as.hint}>attribution</Text>
      </View>
      {sorted.map(h => {
        const v     = h.contribution_pct ?? 0;
        const isPos = v >= 0;
        const wPct  = Math.abs(v) / maxAbs * 50;
        return (
          <View key={h.ticker} style={as.row}>
            <Text style={as.ticker} numberOfLines={1}>{h.ticker}</Text>
            <View style={as.track}>
              <View style={as.axis} />
              {isPos
                ? <View style={[as.barPos, { width: `${wPct}%` }]} />
                : <View style={[as.barNeg, { width: `${wPct}%`, right: '50%' }]} />
              }
            </View>
            <View style={as.valBlock}>
              <Text style={[as.val, { color: isPos ? '#16A34A' : '#DC2626' }]}>
                {isPos ? '+' : ''}{v.toFixed(2)}%
              </Text>
              {h.dollar_gain != null && (
                <Text style={as.sub}>
                  {h.dollar_gain >= 0 ? '+' : '−'}${Math.abs(h.dollar_gain).toLocaleString('en-US', { maximumFractionDigits: 0 })}
                </Text>
              )}
            </View>
          </View>
        );
      })}
    </View>
  );
}

function YtdHoldingRow({ a }) {
  const cGain   = a.dollar_gain    == null ? '#8090a8' : a.dollar_gain    >= 0 ? '#16A34A' : '#DC2626';
  const cContrib= a.contribution_pct== null ? '#8090a8' : a.contribution_pct >= 0 ? '#16A34A' : '#DC2626';
  const gainStr = a.dollar_gain == null
    ? '—'
    : `${a.dollar_gain >= 0 ? '+' : '−'}$${Math.abs(a.dollar_gain).toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
  const contribStr = a.contribution_pct == null
    ? '—'
    : `${a.contribution_pct >= 0 ? '+' : ''}${a.contribution_pct.toFixed(2)}%`;
  return (
    <View style={as.holdRow}>
      <View style={[{ flex: 1.3 }, { flexDirection: 'row', alignItems: 'center', gap: 4 }]}>
        {a.price_missing && <Text style={as.missingBadge}>?</Text>}
        {a.is_mm         && <Text style={as.mmBadge}>CASH</Text>}
        <Text style={as.holdTicker}>{a.ticker}</Text>
      </View>
      <Text style={[as.holdNum, { color: cGain }]}>{gainStr}</Text>
      <Text style={[as.holdNum, as.holdContrib, { color: cContrib }]}>{contribStr}</Text>
    </View>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────
const s = StyleSheet.create({
  screen:        { flex: 1, backgroundColor: colors.navy },
  scroll:        { flex: 1 },
  scrollContent: { paddingBottom: 40 },

  center:      { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  loadingText: { color: '#4a6080', marginTop: 12, fontSize: 13 },
  errorText:   { color: '#e05a4e', textAlign: 'center', marginBottom: 16 },
  retryBtn:    { backgroundColor: 'rgba(91,184,212,.15)', paddingVertical: 10, paddingHorizontal: 24, borderRadius: 8, borderWidth: 1, borderColor: colors.primary },
  retryText:   { color: colors.primary, fontWeight: '700', fontSize: 14 },
  emptyText:   { color: '#3a5070', padding: 24, fontSize: 13 },

  // Lock screen
  lockOuter:      { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32 },
  lockCard:       { backgroundColor: '#0d1f38', borderRadius: 16, padding: 32, width: '100%', alignItems: 'center', borderWidth: 1, borderColor: 'rgba(91,184,212,0.3)' },
  lockIcon:       { fontSize: 36, marginBottom: 12 },
  lockTitle:      { fontSize: 18, fontWeight: '800', color: '#f0e8d0', marginBottom: 6 },
  lockHint:       { fontSize: 12, color: '#4a6080', marginBottom: 20, textAlign: 'center' },
  lockInput:      { width: '100%', backgroundColor: '#081526', borderWidth: 1, borderColor: '#1e3a5a', borderRadius: 8, color: '#f0e8d0', fontSize: 15, padding: 12, marginBottom: 8 },
  lockInputError: { borderColor: '#e05a5a' },
  lockErrText:    { color: '#e05a5a', fontSize: 12, marginBottom: 8 },
  lockBtn:        { width: '100%', backgroundColor: colors.primary, borderRadius: 8, paddingVertical: 13, alignItems: 'center', marginTop: 4 },
  lockBtnText:    { color: colors.navy, fontWeight: '800', fontSize: 15, letterSpacing: 0.4 },

  // Branch selector
  branchBar:          { flexDirection: 'row', backgroundColor: '#060f1e', borderBottomWidth: 1, borderBottomColor: 'rgba(91,184,212,0.2)', padding: 8, gap: 8 },
  branchBtn:          { flex: 1, paddingVertical: 8, alignItems: 'center', borderRadius: 8, borderWidth: 1, borderColor: 'transparent' },
  branchBtnActive:    { backgroundColor: 'rgba(91,184,212,0.12)', borderColor: 'rgba(91,184,212,0.4)' },
  branchBtnText:      { fontSize: 11, fontWeight: '600', color: '#3a5070' },
  branchBtnTextActive:{ color: colors.primary },

  // Sub-tab bar (LP Fund)
  subTabBar:        { flexDirection: 'row', backgroundColor: '#0a1628', borderBottomWidth: 1, borderBottomColor: 'rgba(255,255,255,0.06)' },
  subTab:           { flex: 1, paddingVertical: 9, alignItems: 'center' },
  subTabActive:     { borderBottomWidth: 2, borderBottomColor: colors.primary },
  subTabText:       { fontSize: 10, fontWeight: '600', color: '#4a6080', letterSpacing: 0.2 },
  subTabTextActive: { color: colors.primary },

  // Account overview stats grid (matches fund overview style)
  acctOverviewGrid:   { flexDirection: 'row', flexWrap: 'wrap', paddingHorizontal: 12, paddingTop: 12, gap: 8 },
  acctStatCard:       { flex: 1, minWidth: '45%', backgroundColor: '#0e1e35', borderRadius: 10, padding: 12, borderWidth: 1, borderColor: 'rgba(201,168,76,0.15)' },
  acctStatPrimary:    { backgroundColor: '#11223d', borderColor: 'rgba(201,168,76,0.35)' },
  acctStatLabel:      { fontSize: 9, fontWeight: '700', letterSpacing: 1.2, color: '#4a6080', marginBottom: 4 },
  acctStatValue:      { fontSize: 20, fontWeight: '800', color: '#e8f0f8', letterSpacing: -0.5 },
  acctStatSub:        { fontSize: 10, color: '#4a6080', marginTop: 2 },

  // Section row header (label + button)
  fundSectionRow:     { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingTop: 18, paddingBottom: 6 },
  sectionLabel:       { fontSize: 10, fontWeight: '800', letterSpacing: 1.5, color: '#4a6080' },

  // Import button (small, inline)
  importBtn:          { flexDirection: 'row', alignItems: 'center', gap: 5, backgroundColor: 'rgba(201,168,76,0.08)', borderRadius: 6, paddingHorizontal: 10, paddingVertical: 5, borderWidth: 1, borderColor: 'rgba(201,168,76,0.25)' },
  importBtnText:      { fontSize: 11, fontWeight: '700', color: colors.primary },

  // Full-width import button
  importBtn2:         { backgroundColor: 'rgba(201,168,76,0.08)', borderRadius: 8, paddingVertical: 12, alignItems: 'center', borderWidth: 1, borderColor: 'rgba(201,168,76,0.3)', marginBottom: 8 },
  importBtn2Text:     { fontSize: 12, fontWeight: '700', color: colors.primary, letterSpacing: 0.5 },

  // Rename inline form
  renameIconBtn:   { padding: 6, marginRight: 6 },
  renameIconText:  { fontSize: 15, color: '#5bb8d4', fontWeight: '700' },
  renameForm: {
    marginHorizontal: 12, marginTop: -6, marginBottom: 10,
    backgroundColor: '#0a1928', borderRadius: 10, padding: 14,
    borderWidth: 1, borderColor: 'rgba(91,184,212,0.3)',
  },
  renameFormTitle: { fontSize: 9, fontWeight: '800', color: '#5bb8d4', letterSpacing: 1.2, marginBottom: 10 },
  renameInput: {
    backgroundColor: '#081526', borderRadius: 8, borderWidth: 1,
    borderColor: '#1e3a5a', paddingHorizontal: 12, paddingVertical: 10,
    fontSize: 13, color: '#e8f0f8', marginBottom: 8,
  },

  // Table card container
  fundTableCard:      { marginHorizontal: 12, backgroundColor: '#0e1e35', borderRadius: 10, borderWidth: 1, borderColor: 'rgba(201,168,76,0.1)', overflow: 'hidden', marginBottom: 4 },

  // Positions table
  posTableHead:       { flexDirection: 'row', paddingHorizontal: 10, paddingVertical: 7, backgroundColor: '#081526', borderBottomWidth: 1, borderBottomColor: 'rgba(201,168,76,0.1)' },
  posTh:              { flex: 1, fontSize: 8, fontWeight: '800', color: '#3a5070', letterSpacing: 0.8, textAlign: 'right' },
  posTableRow:        { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 10, paddingVertical: 8 },
  posTableBorder:     { borderTopWidth: 1, borderTopColor: 'rgba(255,255,255,0.04)' },
  posTotalRow:        { borderTopWidth: 1, borderTopColor: 'rgba(201,168,76,0.2)', backgroundColor: 'rgba(201,168,76,0.04)' },
  posTicker:          { fontSize: 12, fontWeight: '700', color: '#e8f0f8', letterSpacing: 0.5 },
  posName:            { fontSize: 9, color: '#3a5070' },
  posNum:             { flex: 1, fontSize: 11, fontWeight: '600', color: '#8090a8', textAlign: 'right' },

  // Account history / cash flow table
  flowRow:            { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 10, paddingVertical: 8, gap: 8 },
  flowBorder:         { borderTopWidth: 1, borderTopColor: 'rgba(255,255,255,0.04)' },
  flowDate:           { fontSize: 11, color: '#6a8aaa', width: 72 },
  flowAction:         { flex: 1, fontSize: 11, color: '#a0b0c8' },
  flowAmt:            { fontSize: 12, fontWeight: '700', textAlign: 'right' },

  // Fund / account summary cards (list view)
  fundSummaryCard:    { marginHorizontal: 12, marginBottom: 10, backgroundColor: '#0e1e35', borderRadius: 12, borderWidth: 1, borderColor: 'rgba(201,168,76,0.2)', overflow: 'hidden' },
  fundSummaryHeader:  { flexDirection: 'row', alignItems: 'center', padding: 14, paddingBottom: 8 },
  fundSummaryName:    { fontSize: 14, fontWeight: '700', color: '#e8f0f8', marginBottom: 2 },
  fundSummaryShort:   { fontSize: 11, color: '#4a6080' },
  fundSummaryStatusBadge: { backgroundColor: 'rgba(74,200,112,0.12)', borderRadius: 4, paddingHorizontal: 8, paddingVertical: 3, borderWidth: 1, borderColor: 'rgba(74,200,112,0.3)' },
  fundSummaryStatusText:  { fontSize: 9, fontWeight: '800', color: '#4cc870', letterSpacing: 0.8 },
  fundSummaryMetrics: { flexDirection: 'row', borderTopWidth: 1, borderTopColor: 'rgba(255,255,255,0.05)', paddingHorizontal: 14, paddingVertical: 10 },
  fundSummaryMetric:  { flex: 1, alignItems: 'center' },
  fundSummaryMetricLabel: { fontSize: 8, fontWeight: '700', color: '#3a5070', letterSpacing: 0.8, marginBottom: 3 },
  fundSummaryMetricValue: { fontSize: 13, fontWeight: '700', color: '#e8f0f8' },
  fundSummaryCTA:     { fontSize: 11, fontWeight: '700', color: colors.primary, textAlign: 'right', paddingHorizontal: 14, paddingBottom: 10 },

  // Fund list empty state
  fundListEmpty:      { alignItems: 'center', paddingTop: 40, paddingHorizontal: 24 },
  fundListEmptyText:  { fontSize: 16, fontWeight: '700', color: '#4a6080', marginBottom: 6 },
  fundListEmptyHint:  { fontSize: 12, color: '#3a5070', textAlign: 'center' },

  // Create account form
  createFundForm:     { backgroundColor: '#0e1e35', borderRadius: 12, padding: 14, borderWidth: 1, borderColor: 'rgba(201,168,76,0.2)', marginBottom: 12 },
  createFundTitle:    { fontSize: 11, fontWeight: '800', color: colors.primary, letterSpacing: 1, marginBottom: 10 },
  createFundInput:    { backgroundColor: '#081526', borderRadius: 8, borderWidth: 1, borderColor: '#1e3a5a', paddingHorizontal: 12, paddingVertical: 10, fontSize: 13, color: '#e8f0f8', marginBottom: 8 },

  // Detail nav title
  detailNavTitle:     { flex: 1, fontSize: 13, fontWeight: '700', color: '#e8f0f8', textAlign: 'center', marginRight: 80 },

  // My Portfolio branch container
  portfolioBranch: { flex: 1 },

  // YTD Upload card
  ytdCard:      { backgroundColor: '#0e1d38', borderRadius: 12, padding: 16, marginBottom: 12, borderWidth: 1, borderColor: 'rgba(91,184,212,0.25)' },
  ytdCardHead:  { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 },
  ytdCardTitle: { fontSize: 11, fontWeight: '800', letterSpacing: 1.2, color: colors.primary },
  ytdBadge:     { backgroundColor: 'rgba(91,184,212,0.12)', borderRadius: 4, paddingHorizontal: 7, paddingVertical: 2 },
  ytdBadgeText: { fontSize: 9, fontWeight: '800', color: colors.primary, letterSpacing: 0.5 },
  ytdCardDesc:  { fontSize: 11, color: '#4a6080', lineHeight: 16, marginBottom: 14 },

  // File picker rows
  fileRow:      { flexDirection: 'row', alignItems: 'center', backgroundColor: '#081526', borderRadius: 8, borderWidth: 1, borderColor: '#1e3a5a', padding: 10, marginBottom: 8, gap: 10 },
  fileRowLeft:  { flex: 1 },
  fileRowLabel: { fontSize: 10, fontWeight: '700', color: '#4a6080', letterSpacing: 0.5, marginBottom: 2 },
  fileRowReq:   { color: colors.primary },
  fileRowName:  { fontSize: 12, color: '#c0d0e0', fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace' },
  fileRowIcon:  { width: 28, height: 28, borderRadius: 6, backgroundColor: '#1e3a5a', alignItems: 'center', justifyContent: 'center' },
  fileRowIconDone: { backgroundColor: 'rgba(22,163,74,0.25)' },

  // Begin value
  beginValueRow:   { marginBottom: 12, marginTop: 4 },
  beginValueLabel: { fontSize: 10, fontWeight: '700', color: '#4a6080', letterSpacing: 0.5, marginBottom: 6 },
  beginValueInput: { backgroundColor: '#081526', borderWidth: 1, borderColor: '#1e3a5a', borderRadius: 8, color: '#f0e8d0', fontSize: 14, padding: 10 },

  // YTD compute button
  ytdBtn:     { backgroundColor: colors.primary, borderRadius: 8, paddingVertical: 12, alignItems: 'center', marginTop: 4 },
  ytdBtnText: { color: colors.navy, fontWeight: '800', fontSize: 14, letterSpacing: 0.3 },
  ytdError:   { color: '#e05a4e', fontSize: 12, marginBottom: 10, lineHeight: 16 },

  // YTD Result card
  ytdResultCard:   { backgroundColor: '#0a1a30', borderRadius: 12, padding: 14, marginBottom: 12, borderWidth: 1, borderColor: 'rgba(22,163,74,0.25)' },
  ytdSectionLabel: { fontSize: 9, fontWeight: '800', letterSpacing: 1.2, color: '#3a5070', marginBottom: 10 },
  ytdMetricsRow:   { flexDirection: 'row', gap: 6, marginBottom: 8, flexWrap: 'wrap' },
  ytdMetric:       { flex: 1, minWidth: 70, backgroundColor: '#0e1d38', borderRadius: 8, padding: 9, borderWidth: 1, borderColor: 'rgba(255,255,255,0.06)' },
  ytdMetricKey:    { fontSize: 8, fontWeight: '800', letterSpacing: 0.8, color: '#3a5070', marginBottom: 3 },
  ytdMetricVal:    { fontSize: 14, fontWeight: '800', color: '#f0e8d0' },
  ytdSubNote:      { fontSize: 10, color: '#3a5070', marginBottom: 10, lineHeight: 15 },

  // Attribution table headers
  attrTableHead:   { flexDirection: 'row', paddingBottom: 6, borderBottomWidth: 1, borderBottomColor: '#1e3a5a', marginBottom: 2 },
  attrTh:          { flex: 1, fontSize: 9, fontWeight: '700', letterSpacing: 0.6, color: '#3a5070', textAlign: 'right' },

  // Past runs (snapshots) card
  snapsCard:    { backgroundColor: '#0e1d38', borderRadius: 12, padding: 14, marginBottom: 12, borderWidth: 1, borderColor: 'rgba(255,255,255,0.07)' },
  snapRow:      { flexDirection: 'row', alignItems: 'center', paddingVertical: 10 },
  snapRowBorder:{ borderTopWidth: 1, borderTopColor: '#1e3a5a' },
  snapDate:     { fontSize: 12, fontWeight: '700', color: '#c0d0e0', letterSpacing: 0.2 },
  snapMeta:     { fontSize: 10, color: '#3a5070', marginTop: 2 },
  snapRight:    { alignItems: 'flex-end', gap: 6 },
  snapReturn:   { fontSize: 15, fontWeight: '800' },
  snapDeleteBtn:{ backgroundColor: 'rgba(220,38,38,0.12)', borderRadius: 5, paddingHorizontal: 8, paddingVertical: 3 },
  snapDeleteText:{ fontSize: 10, fontWeight: '700', color: '#DC2626' },

  // Portal cards (paper portfolios / quarterly reports)
  portfolioCard:      { backgroundColor: '#0e1d38', borderRadius: 12, padding: 20, marginBottom: 12, borderWidth: 1, borderColor: 'rgba(91,184,212,0.15)' },
  portfolioCardTitle: { fontSize: 15, fontWeight: '700', color: '#f0e8d0', marginBottom: 8 },
  portfolioCardDesc:  { fontSize: 12, color: '#6a8aaa', lineHeight: 18, marginBottom: 14 },
  portfolioBtn:       { backgroundColor: colors.primary, borderRadius: 8, paddingVertical: 10, alignItems: 'center', borderWidth: 1, borderColor: colors.primary },
  portfolioBtnText:   { color: colors.navy, fontWeight: '700', fontSize: 13 },

  // Rebalance section styles
  rebalCard: {
    backgroundColor: '#0e1d38', borderRadius: 12, padding: 16, marginBottom: 12,
    borderWidth: 1, borderColor: 'rgba(91,184,212,0.2)',
  },
  rebalLastCard: {
    backgroundColor: '#0e1d38', borderRadius: 12, padding: 16, marginBottom: 12,
    borderWidth: 1, borderColor: 'rgba(91,184,212,0.15)',
  },
  rebalCardTitle:  { fontSize: 10, fontWeight: '800', letterSpacing: 1.5, color: colors.primary, marginBottom: 8 },
  rebalCardDesc:   { fontSize: 12, color: '#6a8aaa', lineHeight: 17, marginBottom: 12 },
  rebalFilePicker: {
    flexDirection: 'row', alignItems: 'center', gap: 10, padding: 14,
    borderWidth: 1.5, borderColor: 'rgba(91,184,212,0.3)', borderStyle: 'dashed',
    borderRadius: 10, backgroundColor: 'rgba(91,184,212,0.05)', marginBottom: 12,
  },
  rebalFilePickerText: { fontSize: 13, fontWeight: '600', color: '#c9d8e8', flex: 1 },
  rebalToggleRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingVertical: 8, borderTopWidth: 1, borderTopColor: 'rgba(255,255,255,0.05)',
  },
  rebalToggleLabel: { fontSize: 13, fontWeight: '600', color: '#c9d8e8', flex: 1, marginRight: 12 },
  rebalRunBtn: {
    backgroundColor: colors.primary, borderRadius: 8, paddingVertical: 13,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    marginTop: 12,
  },
  rebalRunBtnText: { color: colors.navy, fontWeight: '800', fontSize: 13, letterSpacing: 0.5 },
  rebalProgressTrack: {
    height: 5, backgroundColor: 'rgba(255,255,255,0.1)', borderRadius: 3,
    overflow: 'hidden', marginBottom: 6,
  },
  rebalProgressFill: { height: '100%', backgroundColor: colors.primary, borderRadius: 3 },
  rebalProgressLabel: { fontSize: 12, color: '#6a8aaa', marginBottom: 4 },
  rebalStatusDone: { fontSize: 13, fontWeight: '600', color: '#4ade80', marginBottom: 4 },
  rebalStatusFail: { fontSize: 13, color: '#f87171', marginBottom: 4 },
  rebalLastMeta: { fontSize: 12, color: '#6a8aaa', marginBottom: 10 },
  rebalLastActions: { flexDirection: 'row', gap: 10 },

  // Fund list view
  fundListHint: { fontSize: 11, color: '#3a5070', marginBottom: 12, letterSpacing: 0.3 },
  fundCard: {
    backgroundColor: '#0e1d38',
    borderRadius: 12,
    padding: 16,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: 'rgba(91,184,212,0.25)',
    borderLeftWidth: 3,
    borderLeftColor: colors.primary,
  },
  fundCardHeader:    { flexDirection: 'row', alignItems: 'flex-start', marginBottom: 12 },
  fundCardName:      { fontSize: 15, fontWeight: '800', color: '#f0e8d0', marginBottom: 3 },
  fundCardShort:     { fontSize: 11, color: '#4a6080' },
  fundStatusBadge:   { borderWidth: 1, borderRadius: 5, paddingHorizontal: 7, paddingVertical: 2, marginLeft: 8, marginTop: 2 },
  fundStatusText:    { fontSize: 9, fontWeight: '800', letterSpacing: 0.5 },
  fundCardMetrics:   { flexDirection: 'row', gap: 8, marginBottom: 12 },
  fundCardMetric:    { flex: 1, backgroundColor: '#081526', borderRadius: 8, padding: 8, borderWidth: 1, borderColor: 'rgba(255,255,255,0.05)' },
  fundCardMetricLabel:{ fontSize: 8, fontWeight: '700', color: '#3a5070', letterSpacing: 0.6, marginBottom: 3 },
  fundCardMetricValue:{ fontSize: 13, fontWeight: '800', color: '#f0e8d0' },
  fundCardCta:       { alignSelf: 'flex-end' },
  fundCardCtaText:   { fontSize: 12, fontWeight: '700', color: colors.primary },

  // Fund detail navigation bar (back button)
  detailNavBar:  { flexDirection: 'row', alignItems: 'center', backgroundColor: '#060f1e', borderBottomWidth: 1, borderBottomColor: 'rgba(91,184,212,0.15)', paddingHorizontal: 12, paddingVertical: 8 },
  backBtn:       { flexDirection: 'row', alignItems: 'center', gap: 4 },
  backBtnText:   { fontSize: 13, fontWeight: '700', color: colors.primary },

  // Overview
  overviewWrap: { padding: 14 },
  heroCard:  { backgroundColor: '#0e1d38', borderRadius: 12, padding: 18, borderWidth: 1, borderColor: 'rgba(91,184,212,0.3)', marginBottom: 10 },
  heroLabel: { fontSize: 9, fontWeight: '800', letterSpacing: 1.2, color: colors.primary, marginBottom: 4 },
  heroValue: { fontSize: 32, fontWeight: '800', color: '#f0e8d0', letterSpacing: -1, fontVariant: ['tabular-nums'] },
  heroGain:  { fontSize: 12, marginTop: 4 },
  statRow:   { flexDirection: 'row', gap: 8, marginBottom: 10 },
  statCard:  { flex: 1, backgroundColor: '#0e1d38', borderRadius: 10, padding: 12, borderWidth: 1, borderColor: 'rgba(91,184,212,0.12)' },
  statLabel: { fontSize: 8, fontWeight: '800', letterSpacing: 0.8, color: '#5BB8D4', marginBottom: 3 },
  statValue: { fontSize: 15, fontWeight: '800', color: '#f0e8d0', fontVariant: ['tabular-nums'] },
  statSub:   { fontSize: 10, color: '#4a6080', marginTop: 2 },
  econCard:     { backgroundColor: '#0e1d38', borderRadius: 10, padding: 14, borderWidth: 1, borderColor: 'rgba(255,255,255,0.07)' },
  econTitle:    { fontSize: 9, fontWeight: '800', letterSpacing: 1, color: '#4a6080', marginBottom: 10 },
  econRow:      { flexDirection: 'row', gap: 8, flexWrap: 'wrap' },
  econPill:     { backgroundColor: 'rgba(255,255,255,0.06)', borderRadius: 8, paddingVertical: 7, paddingHorizontal: 12, alignItems: 'center' },
  econPillGold: { backgroundColor: colors.primary },
  econPillVal:  { fontSize: 16, fontWeight: '800', color: '#f0e8d0' },
  econPillLbl:  { fontSize: 9, color: '#6080a0', marginTop: 1, fontWeight: '600' },

  // Tables
  tableWrap:   { padding: 14 },
  tableHeader: { borderBottomWidth: 1, borderBottomColor: 'rgba(255,255,255,0.1)', paddingBottom: 6, marginBottom: 2 },
  tableRow:    { flexDirection: 'row', paddingVertical: 8, alignItems: 'center', borderBottomWidth: 1, borderBottomColor: 'rgba(255,255,255,0.04)' },
  tableRowAlt: { backgroundColor: 'rgba(255,255,255,0.02)' },
  totalsRow:   { borderTopWidth: 1, borderTopColor: 'rgba(91,184,212,0.3)', marginTop: 2, paddingTop: 10 },
  th:      { flex: 1, fontSize: 9, fontWeight: '700', letterSpacing: 0.6, color: '#3a5070', textTransform: 'uppercase' },
  thRight: { textAlign: 'right' },
  td:      { flex: 1, fontSize: 11, color: '#8090a8' },
  tdRight: { textAlign: 'right' },
  tdBold:  { color: '#d8d0c0', fontWeight: '700' },
  tdDim:   { color: '#4a6080' },
  symbolCell: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  symbolText: { fontSize: 12, fontWeight: '700', color: colors.primary },
  lotBadge:   { fontSize: 8, backgroundColor: 'rgba(91,184,212,0.2)', color: colors.primary, paddingHorizontal: 4, paddingVertical: 1, borderRadius: 4, fontWeight: '700' },

  // Import row (Positions + LPs tabs)
  importRow: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    paddingHorizontal: 14, paddingTop: 10, paddingBottom: 6, flexWrap: 'wrap',
  },
  importBtn: {
    paddingHorizontal: 12, paddingVertical: 6,
    borderWidth: 1, borderColor: 'rgba(91,184,212,0.4)', borderRadius: 7,
    backgroundColor: 'transparent',
  },
  importBtnDisabled: { opacity: 0.5 },
  importBtnText: { fontSize: 11, fontWeight: '700', color: '#5BB8D4', letterSpacing: 0.2 },
  importStatus: { fontSize: 11 },
  importStatusOk:  { color: '#4cc870' },
  importStatusErr: { color: '#e06050' },

  // Activity
  activityWrap:  { padding: 14 },
  activityRow:   { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: 'rgba(255,255,255,0.05)' },
  activityLeft:  { flex: 1, marginRight: 12 },
  activityRight: { alignItems: 'flex-end' },
  catPill:       { alignSelf: 'flex-start', paddingHorizontal: 8, paddingVertical: 2, borderRadius: 10, marginBottom: 4 },
  catPillText:   { fontSize: 9, fontWeight: '700', letterSpacing: 0.5 },
  actDesc:       { fontSize: 11, color: '#6080a0', lineHeight: 15 },
  actAmount:     { fontSize: 13, fontWeight: '700', color: '#d8d0c0' },
  actDate:       { fontSize: 10, color: '#3a5070', marginTop: 2 },

  // Waterfall
  wfallWrap:     { padding: 14 },
  wfallCard:     { backgroundColor: '#0a1628', borderWidth: 1, borderColor: '#1e3a5a', borderRadius: 10, marginBottom: 16, overflow: 'hidden' },
  wRow:          { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 10, paddingHorizontal: 14, borderBottomWidth: 1, borderBottomColor: '#0f2240' },
  wRowHighlight: { backgroundColor: 'rgba(91,184,212,0.06)' },
  wRowLast:      { borderBottomWidth: 0 },
  wLabel:        { fontSize: 11, color: '#4a6080', flex: 1, marginRight: 8 },
  wValue:        { fontSize: 13, fontWeight: '700', color: '#c0cfe0' },
  wfallSubhead:  { fontSize: 9, fontWeight: '800', letterSpacing: 1, color: '#3a5070', marginBottom: 4, paddingHorizontal: 14 },
  wfallWarn:     { backgroundColor: 'rgba(220,160,40,0.1)', borderWidth: 1, borderColor: 'rgba(220,160,40,0.3)', borderRadius: 8, padding: 12, marginBottom: 12 },
  wfallWarnText: { fontSize: 11, color: '#e0a030', lineHeight: 16 },

  // Managed Account selector
  accSelectorRow:       { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 14 },
  accSelectorBtn:       { paddingHorizontal: 12, paddingVertical: 7, borderRadius: 8, borderWidth: 1, borderColor: '#1e3a5a', backgroundColor: '#0a1628' },
  accSelectorBtnActive: { borderColor: colors.primary, backgroundColor: 'rgba(91,184,212,0.12)' },
  accSelectorText:      { fontSize: 12, fontWeight: '600', color: '#4a6080' },
  accSelectorTextActive:{ color: colors.primary, fontWeight: '800' },
  accNameBadge:         { backgroundColor: 'rgba(91,184,212,0.1)', borderRadius: 8, paddingHorizontal: 12, paddingVertical: 6, alignSelf: 'flex-start', marginBottom: 14, borderWidth: 1, borderColor: 'rgba(91,184,212,0.25)' },
  accNameBadgeText:     { fontSize: 12, fontWeight: '700', color: colors.primary },

  // ── S&P 500 comparison card ─────────────────────────────────────────────
  spyCard:          { backgroundColor: 'rgba(255,255,255,0.04)', borderRadius: 12, borderWidth: 1, borderColor: 'rgba(91,184,212,0.2)', padding: 14, marginTop: 14, marginBottom: 4 },
  spyCardTitle:     { fontSize: 10, fontWeight: '800', color: '#4a6080', letterSpacing: 0.8, marginBottom: 10 },
  spyLiveBadge:     { fontSize: 9, color: '#16A34A', fontWeight: '700', letterSpacing: 0.5 },
  spyCardRow:       { flexDirection: 'row', alignItems: 'center', gap: 6 },
  spyMetric:        { flex: 1, alignItems: 'center' },
  spyMetricLabel:   { fontSize: 9, fontWeight: '700', color: '#4a6080', letterSpacing: 0.5, marginBottom: 3 },
  spyMetricVal:     { fontSize: 14, fontWeight: '800', minWidth: 0 },
  spyMetricSub:     { fontSize: 9, color: '#3a5070', marginTop: 2 },
  spyVs:            { fontSize: 11, color: '#3a5070', fontWeight: '600', paddingHorizontal: 4 },
  spyAlpha:         { flex: 1.2, alignItems: 'center', borderRadius: 10, padding: 8 },
  spyAlphaPos:      { backgroundColor: 'rgba(22,163,74,0.12)', borderWidth: 1, borderColor: 'rgba(22,163,74,0.3)' },
  spyAlphaNeg:      { backgroundColor: 'rgba(220,38,38,0.1)', borderWidth: 1, borderColor: 'rgba(220,38,38,0.25)' },
  spyAlphaLabel:    { fontSize: 9, fontWeight: '700', color: '#4a6080', letterSpacing: 0.5, marginBottom: 2 },
  spyAlphaVal:      { fontSize: 14, fontWeight: '800', minWidth: 0 },
  spyAlphaSub:      { fontSize: 9, color: '#6a8aaa', marginTop: 2 },

  // ── Rebalanced branch panel ──────────────────────────────────────────────
  rebalBranchWrap:         { padding: 14 },
  rebalBranchHeader:       { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 16 },
  rebalBranchTitle:        { fontSize: 11, fontWeight: '800', color: colors.primary, letterSpacing: 0.8 },
  rebalBranchMeta:         { fontSize: 10, color: '#4a6080', marginTop: 3 },
  rebalEmailBadge:         { borderRadius: 8, paddingVertical: 4, paddingHorizontal: 8, maxWidth: 180 },
  rebalEmailOk:            { backgroundColor: 'rgba(22,163,74,0.12)', borderWidth: 1, borderColor: 'rgba(22,163,74,0.3)' },
  rebalEmailFail:          { backgroundColor: 'rgba(220,38,38,0.1)', borderWidth: 1, borderColor: 'rgba(220,38,38,0.25)' },
  rebalEmailBadgeText:     { fontSize: 10, color: '#8090a8', fontWeight: '600' },
  rebalStratBlock:         { backgroundColor: 'rgba(255,255,255,0.02)', borderRadius: 12, borderWidth: 1, borderColor: 'rgba(255,255,255,0.06)', padding: 12, marginBottom: 12 },
  rebalStratBlockPrimary:  { borderColor: 'rgba(91,184,212,0.25)', backgroundColor: 'rgba(91,184,212,0.03)' },
  rebalStratLabelRow:      { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 6 },
  rebalStratLabel:         { fontSize: 10, fontWeight: '800', color: '#c0cfe0', letterSpacing: 0.5, flex: 1 },
  rebalStratPrimaryBadge:  { fontSize: 9, color: colors.primary, fontWeight: '700', backgroundColor: 'rgba(91,184,212,0.15)', paddingHorizontal: 6, paddingVertical: 2, borderRadius: 4 },
  rebalStratCount:         { fontSize: 10, color: '#4a6080' },
  rebalEmptyWrap:          { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 40, marginTop: 60 },
  rebalEmptyIcon:          { fontSize: 40, marginBottom: 16 },
  rebalEmptyTitle:         { fontSize: 14, fontWeight: '800', color: '#4a6080', marginBottom: 8 },
  rebalEmptyDesc:          { fontSize: 12, color: '#3a5070', textAlign: 'center', lineHeight: 18 },

  // ── Rebalance result table ──────────────────────────────────────────────
  rebalResultWrap:  { marginTop: 12, borderTopWidth: 1, borderTopColor: 'rgba(91,184,212,0.15)', paddingTop: 12 },
  rebalResultTitle: { fontSize: 10, fontWeight: '800', color: colors.primary, letterSpacing: 0.6, marginBottom: 8 },
  // Arrow between current → target — gold, visually distinct from the dark row background
  rebalArrow:       { width: 18, textAlign: 'center', fontSize: 11, fontWeight: '800',
                      color: colors.primary, opacity: 0.85, paddingHorizontal: 2 },
  // Sector label — dim, truncated
  rebalMeta:        { fontSize: 10, color: '#7a8a9a', letterSpacing: 0.2 },
  // Recent development — slightly lighter, wraps to 2 lines
  rebalDev:         { fontSize: 10, color: '#6a7a8a', lineHeight: 14 },
});

// Styles for YtdAttribView / YtdHoldingRow (light-on-dark, matching fund theme)
const as = StyleSheet.create({
  wrap:       { marginVertical: 10 },
  summaryRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 },
  pill:       { paddingHorizontal: 10, paddingVertical: 4, borderRadius: 5 },
  pillText:   { fontWeight: '800', fontSize: 12 },
  hint:       { fontSize: 10, color: '#3a5070', fontStyle: 'italic' },

  row:      { flexDirection: 'row', alignItems: 'center', paddingVertical: 4, gap: 6 },
  ticker:   { width: 52, fontSize: 11, fontWeight: '800', color: colors.primary, letterSpacing: 0.3 },
  track:    { flex: 1, height: 14, position: 'relative', justifyContent: 'center' },
  axis:     { position: 'absolute', left: '50%', top: 0, bottom: 0, width: 1, backgroundColor: '#1e3a5a' },
  barPos:   { position: 'absolute', left: '50%', height: 10, backgroundColor: 'rgba(22,163,74,0.8)', borderRadius: 2 },
  barNeg:   { position: 'absolute', height: 10, backgroundColor: 'rgba(220,38,38,0.8)', borderRadius: 2 },
  valBlock: { width: 70, alignItems: 'flex-end' },
  val:      { fontSize: 11, fontWeight: '800' },
  sub:      { fontSize: 9, color: '#3a5070', marginTop: 1 },

  // Holding rows
  holdRow:      { flexDirection: 'row', paddingVertical: 6, borderBottomWidth: 1, borderBottomColor: '#0f2240', alignItems: 'center' },
  holdTicker:   { fontSize: 12, fontWeight: '700', color: colors.primary },
  holdNum:      { flex: 1, fontSize: 11, fontWeight: '700', textAlign: 'right' },
  holdContrib:  { fontSize: 12 },
  missingBadge: { fontSize: 9, fontWeight: '800', color: '#e8a060', backgroundColor: 'rgba(232,160,96,0.15)', paddingHorizontal: 4, paddingVertical: 1, borderRadius: 3 },
  mmBadge:      { fontSize: 9, fontWeight: '800', color: '#6090e8', backgroundColor: 'rgba(96,144,232,0.15)', paddingHorizontal: 4, paddingVertical: 1, borderRadius: 3 },
});
