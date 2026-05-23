import { Routes, Route, Navigate } from 'react-router-dom';
import { AppShell } from './components/AppShell';
import { TimerScreen } from './screens/TimerScreen';
import { AnalyticsScreen } from './screens/AnalyticsScreen';
import { SubjectsScreen } from './screens/SubjectsScreen';
import { SettingsScreen } from './screens/SettingsScreen';
import { ThemeProvider } from './hooks/useTheme';

export default function App() {
  return (
    <ThemeProvider>
      <AppShell>
        <Routes>
          <Route path="/" element={<TimerScreen />} />
          <Route path="/analytics" element={<AnalyticsScreen />} />
          <Route path="/subjects" element={<SubjectsScreen />} />
          <Route path="/settings" element={<SettingsScreen />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </AppShell>
    </ThemeProvider>
  );
}
