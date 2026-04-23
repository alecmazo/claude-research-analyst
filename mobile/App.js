import React from 'react';
import { StatusBar } from 'expo-status-bar';
import { NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';

import HomeScreen             from './src/screens/HomeScreen';
import AnalysisScreen         from './src/screens/AnalysisScreen';
import ReportScreen           from './src/screens/ReportScreen';
import ScanScreen             from './src/screens/ScanScreen';
import PortfolioScreen        from './src/screens/PortfolioScreen';
import PortfolioSummaryScreen from './src/screens/PortfolioSummaryScreen';
import SettingsScreen         from './src/screens/SettingsScreen';
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

export default function App() {
  return (
    <NavigationContainer>
      <StatusBar style="light" />
      <Tab.Navigator
        tabBar={(props) => <CustomTabBar {...props} />}
        screenOptions={{ headerShown: false }}
      >
        <Tab.Screen name="Research"  component={HomeStack} />
        <Tab.Screen name="Scan"      component={ScanScreen} />
        <Tab.Screen name="Portfolio" component={PortfolioStack} />
        <Tab.Screen name="Settings"  component={SettingsScreen} />
      </Tab.Navigator>
    </NavigationContainer>
  );
}
