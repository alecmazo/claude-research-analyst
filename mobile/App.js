import React from 'react';
import { StatusBar } from 'expo-status-bar';
import { NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { Ionicons } from '@expo/vector-icons';

import HomeScreen      from './src/screens/HomeScreen';
import AnalysisScreen  from './src/screens/AnalysisScreen';
import ReportScreen    from './src/screens/ReportScreen';
import ScanScreen      from './src/screens/ScanScreen';
import PortfolioScreen from './src/screens/PortfolioScreen';
import SettingsScreen  from './src/screens/SettingsScreen';
import { colors } from './src/components/theme';

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

const TAB_ICONS = {
  Research:  { active: 'analytics',         inactive: 'analytics-outline'   },
  Scan:      { active: 'pulse',             inactive: 'pulse-outline'        },
  Portfolio: { active: 'briefcase',         inactive: 'briefcase-outline'    },
  Settings:  { active: 'settings',          inactive: 'settings-outline'     },
};

export default function App() {
  return (
    <NavigationContainer>
      <StatusBar style="light" />
      <Tab.Navigator
        screenOptions={({ route }) => ({
          headerShown: false,
          tabBarStyle: {
            backgroundColor: colors.navy,
            borderTopColor: colors.navyLight,
            paddingBottom: 8,
            height: 80,
          },
          tabBarActiveTintColor:   colors.gold,
          tabBarInactiveTintColor: colors.midGray,
          tabBarLabelStyle: { fontSize: 11, fontWeight: '600', marginTop: 2 },
          tabBarIcon: ({ focused, color, size }) => {
            const icons = TAB_ICONS[route.name] || { active: 'ellipse', inactive: 'ellipse-outline' };
            return <Ionicons name={focused ? icons.active : icons.inactive} size={size} color={color} />;
          },
        })}
      >
        <Tab.Screen name="Research"  component={HomeStack} />
        <Tab.Screen name="Scan"      component={ScanScreen} />
        <Tab.Screen name="Portfolio" component={PortfolioScreen} />
        <Tab.Screen name="Settings"  component={SettingsScreen} />
      </Tab.Navigator>
    </NavigationContainer>
  );
}
