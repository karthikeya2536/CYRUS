/**
 * Phase 7.5 - System Validation Dashboard
 * Run this component to execute all system validation tests
 */

import React, { useState } from 'react';
import { supabase } from '../lib/supabase';

const SystemValidation = () => {
  const [testResults, setTestResults] = useState(null);
  const [isRunning, setIsRunning] = useState(false);
  const [error, setError] = useState(null);

  const runAllTests = async () => {
    setIsRunning(true);
    setError(null);
    setTestResults(null);

    try {
      const { data: { user }, error: authError } = await supabase.auth.getUser();
      if (authError || !user) {
        setError('Please log in first');
        setIsRunning(false);
        return;
      }

      // Get session token from Supabase
      const { data: { session } } = await supabase.auth.getSession();
      const token = session?.access_token;

      if (!token) {
        setError('No session token available');
        setIsRunning(false);
        return;
      }

      // Call the system validation edge function
      const response = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/system-validation`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
      });

      if (!response.ok) {
        throw new Error(`Test failed: ${response.statusText}`);
      }

      const results = await response.json();
      setTestResults(results);
    } catch (err) {
      setError(err.message);
    } finally {
      setIsRunning(false);
    }
  };

  const TestCard = ({ name, status, details }) => {
    const isPass = status === 'PASS';
    return (
      <div className={`test-card ${isPass ? 'pass' : 'fail'}`}>
        <div className="test-header">
          <span className="test-name">{name}</span>
          <span className={`test-status ${isPass ? 'pass' : 'fail'}`}>
            {isPass ? '✓ PASS' : '✗ FAIL'}
          </span>
        </div>
        <div className="test-details">
          {details && Object.entries(details).map(([key, value]) => (
            <div key={key} className="detail-row">
              <span className="detail-key">{key}:</span>
              <span className="detail-value">
                {typeof value === 'object' ? JSON.stringify(value) : String(value)}
              </span>
            </div>
          ))}
        </div>
      </div>
    );
  };

  return (
    <div className="system-validation">
      <div className="validation-header">
        <h1>System Validation & Hardening</h1>
        <p className="phase-badge">Phase 7.5</p>
      </div>

      <div className="validation-controls">
        <button
          onClick={runAllTests}
          disabled={isRunning}
          className="run-tests-btn"
        >
          {isRunning ? 'Running Tests...' : 'Run All Tests'}
        </button>
      </div>

      {error && (
        <div className="error-message">
          <strong>Error:</strong> {error}
        </div>
      )}

      {testResults && (
        <div className="test-results">
          <div className="summary-banner">
            <h2>Test Summary</h2>
            <div className="summary-stats">
              <span className="stat pass">{testResults.summary.passed} Passed</span>
              <span className="stat fail">{testResults.summary.failed} Failed</span>
              <span className="stat total">Total: {testResults.summary.total}</span>
            </div>
            <p className="timestamp">
              Completed: {new Date(testResults.timestamp).toLocaleString()}
            </p>
          </div>

          <div className="test-cards">
            <TestCard
              name="Test 1: Gmail Sync (No Duplicates)"
              status={testResults.summary.tests.test1_GmailSyncNoDuplicates}
              details={testResults.detailed_results.test1_GmailSyncNoDuplicates}
            />

            <TestCard
              name="Test 2-4: OmniRoute Provider Connectivity"
              status={testResults.summary.tests.test2to4_ProviderFailover}
              details={testResults.detailed_results.test2to4_ProviderFailover}
            />

            <TestCard
              name="Test 5: Queue Draining (100 jobs)"
              status={testResults.summary.tests.test5_QueueDraining}
              details={testResults.detailed_results.test5_QueueDraining}
            />

            <TestCard
              name="Test 6: Memory Quality (90%+ accuracy)"
              status={testResults.summary.tests.test6_MemoryQuality}
              details={testResults.detailed_results.test6_MemoryQuality}
            />

            <TestCard
              name="Test 7: Cost Measurement"
              status={testResults.summary.tests.test7_CostMeasurement}
              details={testResults.detailed_results.test7_CostMeasurement}
            />

            <TestCard
              name="Test 8: Retrieval Latency (<2s)"
              status={testResults.summary.tests.test8_RetrievalLatency}
              details={testResults.detailed_results.test8_RetrievalLatency}
            />
          </div>
        </div>
      )}

      <style>{`
        .system-validation {
          padding: 2rem;
          max-width: 1200px;
          margin: 0 auto;
        }

        .validation-header {
          display: flex;
          align-items: center;
          gap: 1rem;
          margin-bottom: 2rem;
        }

        .validation-header h1 {
          margin: 0;
          font-size: 1.5rem;
        }

        .phase-badge {
          background: #6366f1;
          color: white;
          padding: 0.25rem 0.75rem;
          border-radius: 999px;
          font-size: 0.875rem;
          font-weight: 600;
        }

        .validation-controls {
          margin-bottom: 2rem;
        }

        .run-tests-btn {
          background: linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%);
          color: white;
          border: none;
          padding: 0.75rem 1.5rem;
          border-radius: 8px;
          font-size: 1rem;
          font-weight: 600;
          cursor: pointer;
          transition: opacity 0.2s;
        }

        .run-tests-btn:hover {
          opacity: 0.9;
        }

        .run-tests-btn:disabled {
          opacity: 0.6;
          cursor: not-allowed;
        }

        .error-message {
          background: #fee2e2;
          border: 1px solid #ef4444;
          color: #991b1b;
          padding: 1rem;
          border-radius: 8px;
          margin-bottom: 1.5rem;
        }

        .summary-banner {
          background: linear-gradient(135deg, #1e293b 0%, #334155 100%);
          color: white;
          padding: 1.5rem;
          border-radius: 12px;
          margin-bottom: 1.5rem;
        }

        .summary-banner h2 {
          margin: 0 0 1rem 0;
          font-size: 1.25rem;
        }

        .summary-stats {
          display: flex;
          gap: 1.5rem;
          margin-bottom: 0.5rem;
        }

        .stat {
          font-size: 1.125rem;
          font-weight: 600;
        }

        .stat.pass { color: #4ade80; }
        .stat.fail { color: #f87171; }
        .stat.total { color: #93c5fd; }

        .timestamp {
          color: #94a3b8;
          font-size: 0.875rem;
          margin: 0;
        }

        .test-cards {
          display: grid;
          gap: 1rem;
        }

        .test-card {
          border: 1px solid #e2e8f0;
          border-radius: 12px;
          padding: 1.25rem;
          background: white;
        }

        .test-card.pass {
          border-color: #4ade80;
          background: #f0fdf4;
        }

        .test-card.fail {
          border-color: #f87171;
          background: #fef2f2;
        }

        .test-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          margin-bottom: 0.75rem;
        }

        .test-name {
          font-weight: 600;
          font-size: 1rem;
        }

        .test-status {
          font-weight: 600;
          padding: 0.25rem 0.75rem;
          border-radius: 999px;
        }

        .test-status.pass {
          background: #4ade80;
          color: #166534;
        }

        .test-status.fail {
          background: #f87171;
          color: #991b1b;
        }

        .test-details {
          font-size: 0.875rem;
          color: #64748b;
        }

        .detail-row {
          display: flex;
          gap: 0.5rem;
          margin-bottom: 0.25rem;
        }

        .detail-key {
          font-weight: 500;
          color: #475569;
        }

        .detail-value {
          font-family: monospace;
        }
      `}</style>
    </div>
  );
};

export default SystemValidation;
