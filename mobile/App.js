import React, { useEffect } from 'react';
import { StatusBar } from 'expo-status-bar';
import { NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import * as Updates from 'expo-updates';

import HomeScreen             from './src/screens/HomeScreen';
import AnalysisScreen         from './src/screens/AnalysisScreen';
import ReportScreen           from './src/screens/ReportScreen';
import ScanScreen             from './src/screens/ScanScreen';
import PortfolioScreen        from './src/screens/PortfolioScreen';
import PortfolioSummaryScreen from './src/screens/PortfolioSummaryScreen';
import PaperTrackerScreen     from './src/screens/PaperTrackerScreen';
import IntelligenceScreen     from './src/screens/IntelligenceScreen';
import SettingsScreen         from './src/screens/SettingsScreen';
import FundScreen             from './src/screens/FundScreen';
import CustomTabBar           from './src/components/CustomTabBar';

const Stack = createNativeStackNavigator();
const Tab   = createBottomTabNavigator();

function HomeStack() {
  return (
    <Stack.Navigator screenOptions={{ headerShown: false }}>
      <Stack.Screen name="Home"     component={HomeScreen} />
      <Stack.Screen name="Analysis" component={AnalysisScreen} />
      <Stack.Screen name="Report"   component={ReportScreen} />
    </Stack.Navigator>
  );
}

function PortfolioStack() {
  return (
    <Stack.Navigator screenOptions={{ headerShown: false }}>
      <Stack.Screen name="Portfolio"        component={PortfolioScreen} />
      <Stack.Screen name="PortfolioSummary" component={PortfolioSummaryScreen} />
    </Stack.Navigator>
  );
}

// Fund section: LP Fund management + Managed Portfolio tracker (both password-gated)
function FundStack() {
  return (
    <Stack.Navigator screenOptions={{ headerShown: false }}>
      <Stack.Screen name="FundHome"    component={FundScreen} />
      <Stack.Screen name="FundTracker" component={PaperTrackerScreen} />
    </Stack.Navigator>
  );
}

// Auto-fetch the latest OTA update on cold launch. expo-updates is
// configured in app.json with checkAutomatically=ON_LOAD and our EAS Update
// channel, so this runs in the background and silently swaps in the new
// JS bundle on the next reload.
async function checkForOtaUpdate() {
  try {
    if (__DEV__) return;   // skip in Expo Go / dev builds
    const result = await Updates.checkForUpdateAsync();
    if (result.isAvailable) {
      await Updates.fetchUpdateAsync();
      // Reload immediately so the user sees the fix without restarting.
      await Updates.reloadAsync();
    }
  } catch (e) {
    // Network glitches, dev client, etc. — fail silently.
    console.log('[OTA] update check skipped:', e?.message || e);
  }
}

export default function App() {
  useEffect(() => { checkForOtaUpdate(); }, []);
  return (
    <NavigationContainer>
      <StatusBar style="light" />
      <Tab.Navigator
        tabBar={(props) => <CustomTabBar {...props} />}
        screenOptions={{ headerShown: false }}
      >
        <Tab.Screen name="Research"     component={HomeStack} />
        <Tab.Screen name="Intelligence" component={IntelligenceScreen} />
        <Tab.Screen name="Scan"         component={ScanScreen} />
        <Tab.Screen name="Portfolio"    component={PortfolioStack} />
        <Tab.Screen name="Fund"         component={FundStack} />
        <Tab.Screen name="Settings"     component={SettingsScreen} />
      </Tab.Navigator>
    </NavigationContainer>
  );
}
