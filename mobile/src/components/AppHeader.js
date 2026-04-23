/**
 * AppHeader — shared navy header with DGA logo + gold ring, matching the web UI.
 *
 * Props:
 *   title       {string}     — screen title shown to the right of the logo
 *   right       {ReactNode}  — optional element anchored to the far right
 *   subtitle    {string}     — optional small line below the title
 */
import React from 'react';
import { View, Text, Image, StyleSheet } from 'react-native';
import { colors } from './theme';

let dgaLogo = null;
try { dgaLogo = require('../../assets/dga_logo_small.png'); } catch (e) {}

export default function AppHeader({ title, right = null, subtitle = null }) {
  return (
    <View style={styles.header}>
      <View style={styles.left}>
        {/* Logo — white background with gold ring, matching .header-logo on the web */}
        {dgaLogo && (
          <View style={styles.logoWrap}>
            <Image source={dgaLogo} style={styles.logoImg} resizeMode="contain" />
          </View>
        )}
        <View style={styles.titleBlock}>
          <Text style={styles.title}>{title}</Text>
          {subtitle ? <Text style={styles.subtitle}>{subtitle}</Text> : null}
        </View>
      </View>
      {right && <View style={styles.right}>{right}</View>}
    </View>
  );
}

const styles = StyleSheet.create({
  header: {
    backgroundColor: colors.navy,
    paddingTop: 60,
    paddingBottom: 18,
    paddingHorizontal: 18,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  left: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    flex: 1,
  },
  // White box with gold border ring — mirrors CSS:
  //   background:#fff; border-radius:8px; padding:5px 10px;
  //   box-shadow: 0 0 0 1.5px gold, 0 2px 6px rgba(0,0,0,.25)
  logoWrap: {
    backgroundColor: colors.white,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderWidth: 1.5,
    borderColor: colors.gold,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.22,
    shadowRadius: 5,
    elevation: 4,
  },
  logoImg: {
    width: 80,
    height: 28,
  },
  titleBlock: { flex: 1 },
  title: {
    color: colors.gold,
    fontSize: 20,
    fontWeight: '800',
    letterSpacing: 0.8,
  },
  subtitle: {
    color: colors.midGray,
    fontSize: 11,
    marginTop: 2,
  },
  right: {
    marginLeft: 12,
    alignItems: 'flex-end',
  },
});
