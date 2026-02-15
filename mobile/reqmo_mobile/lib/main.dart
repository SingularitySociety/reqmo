import 'package:flutter/material.dart';

void main() {
  runApp(const ReqmoMobileApp());
}

// ===== テーマ定数 =====
const _green = Color(0xFF0F766E);
const _orange = Color(0xFFEA580C);
const _bgLight = Color(0xFFF0F4F8);
const _surface = Colors.white;
const _inkMuted = Color(0x80334155);

class ReqmoMobileApp extends StatelessWidget {
  const ReqmoMobileApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'Reqmo',
      debugShowCheckedModeBanner: false,
      theme: ThemeData(
        useMaterial3: true,
        colorScheme: ColorScheme.fromSeed(
          seedColor: _green,
          primary: _green,
          secondary: _orange,
          surface: _surface,
        ),
        scaffoldBackgroundColor: _bgLight,
        fontFamily: 'sans-serif',
        inputDecorationTheme: InputDecorationTheme(
          filled: true,
          fillColor: Colors.white,
          contentPadding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
          border: OutlineInputBorder(
            borderRadius: BorderRadius.circular(10),
            borderSide: const BorderSide(color: Color(0x1A334155)),
          ),
          enabledBorder: OutlineInputBorder(
            borderRadius: BorderRadius.circular(10),
            borderSide: const BorderSide(color: Color(0x1A334155)),
          ),
          focusedBorder: OutlineInputBorder(
            borderRadius: BorderRadius.circular(10),
            borderSide: const BorderSide(color: _green, width: 1.5),
          ),
          labelStyle: const TextStyle(fontSize: 13, color: _inkMuted),
          isDense: true,
        ),
        cardTheme: CardThemeData(
          elevation: 0,
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(14),
            side: const BorderSide(color: Color(0x1A334155)),
          ),
          color: _surface,
        ),
        elevatedButtonTheme: ElevatedButtonThemeData(
          style: ElevatedButton.styleFrom(
            backgroundColor: _green,
            foregroundColor: Colors.white,
            shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(10)),
            minimumSize: const Size(double.infinity, 44),
            textStyle: const TextStyle(fontSize: 14, fontWeight: FontWeight.w700),
          ),
        ),
        appBarTheme: const AppBarTheme(
          backgroundColor: Colors.white,
          foregroundColor: Color(0xFF1E293B),
          elevation: 0,
          surfaceTintColor: Colors.transparent,
          shadowColor: Color(0x14000000),
          titleTextStyle: TextStyle(
            fontSize: 15,
            fontWeight: FontWeight.w800,
            color: Color(0xFF1E293B),
            letterSpacing: 0.4,
          ),
        ),
      ),
      home: const ReqmoHomePage(),
    );
  }
}

class ReqmoHomePage extends StatefulWidget {
  const ReqmoHomePage({super.key});

  @override
  State<ReqmoHomePage> createState() => _ReqmoHomePageState();
}

class _ReqmoHomePageState extends State<ReqmoHomePage> {
  int _index = 0;

  @override
  Widget build(BuildContext context) {
    final pages = [const PassengerPage(), const DriverPage()];

    return Scaffold(
      appBar: AppBar(
        title: Row(
          children: [
            Container(
              width: 28,
              height: 28,
              decoration: BoxDecoration(
                color: _green,
                borderRadius: BorderRadius.circular(8),
              ),
              alignment: Alignment.center,
              child: const Text(
                'R',
                style: TextStyle(
                  color: Colors.white,
                  fontWeight: FontWeight.w900,
                  fontSize: 15,
                ),
              ),
            ),
            const SizedBox(width: 8),
            const Text('Reqmo'),
          ],
        ),
        actions: [
          _StatusChip(label: 'HYBRID', color: _green),
          const SizedBox(width: 6),
          _StatusChip(label: 'TEL', color: _orange),
          const SizedBox(width: 10),
        ],
        bottom: const PreferredSize(
          preferredSize: Size.fromHeight(1),
          child: Divider(height: 1, thickness: 1, color: Color(0x14334155)),
        ),
      ),
      body: pages[_index],
      bottomNavigationBar: NavigationBar(
        selectedIndex: _index,
        onDestinationSelected: (i) => setState(() => _index = i),
        backgroundColor: Colors.white,
        surfaceTintColor: Colors.transparent,
        shadowColor: const Color(0x14000000),
        elevation: 2,
        height: 60,
        labelBehavior: NavigationDestinationLabelBehavior.alwaysShow,
        destinations: const [
          NavigationDestination(
            icon: Icon(Icons.person_outline),
            selectedIcon: Icon(Icons.person),
            label: '乗客',
          ),
          NavigationDestination(
            icon: Icon(Icons.local_taxi_outlined),
            selectedIcon: Icon(Icons.local_taxi),
            label: '運転手',
          ),
        ],
      ),
    );
  }
}

// ===== 乗客ページ =====

class PassengerPage extends StatefulWidget {
  const PassengerPage({super.key});

  @override
  State<PassengerPage> createState() => _PassengerPageState();
}

class _PassengerPageState extends State<PassengerPage> {
  String _pickupMode = 'FIXED_STOP';
  String _dropoffMode = 'FIXED_STOP';
  final _pickupCtrl = TextEditingController();
  final _dropoffCtrl = TextEditingController();
  int _partySize = 1;

  @override
  void dispose() {
    _pickupCtrl.dispose();
    _dropoffCtrl.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return SingleChildScrollView(
      padding: const EdgeInsets.all(16),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          // KPIバー
          _KpiRow(),
          const SizedBox(height: 14),

          // 予約フォーム
          _SectionCard(
            title: '予約リクエスト',
            icon: Icons.taxi_alert_outlined,
            child: Column(
              children: [
                // 乗車
                _FieldGroup(
                  label: '乗車地点',
                  labelColor: _green,
                  icon: Icons.place_outlined,
                  child: Column(
                    children: [
                      _ModeSelector(
                        value: _pickupMode,
                        onChanged: (v) => setState(() => _pickupMode = v),
                      ),
                      const SizedBox(height: 6),
                      if (_pickupMode == 'FIXED_STOP')
                        TextFormField(
                          controller: _pickupCtrl,
                          decoration: const InputDecoration(
                            hintText: 'バス停ID を入力',
                          ),
                        )
                      else
                        TextFormField(
                          controller: _pickupCtrl,
                          decoration: const InputDecoration(
                            hintText: '緯度,経度 (例: 32.989,132.929)',
                          ),
                        ),
                    ],
                  ),
                ),
                const SizedBox(height: 10),

                // 降車
                _FieldGroup(
                  label: '降車地点',
                  labelColor: _orange,
                  icon: Icons.place,
                  child: Column(
                    children: [
                      _ModeSelector(
                        value: _dropoffMode,
                        onChanged: (v) => setState(() => _dropoffMode = v),
                      ),
                      const SizedBox(height: 6),
                      if (_dropoffMode == 'FIXED_STOP')
                        TextFormField(
                          controller: _dropoffCtrl,
                          decoration: const InputDecoration(
                            hintText: 'バス停ID を入力',
                          ),
                        )
                      else
                        TextFormField(
                          controller: _dropoffCtrl,
                          decoration: const InputDecoration(
                            hintText: '緯度,経度 (例: 32.998,132.934)',
                          ),
                        ),
                    ],
                  ),
                ),
                const SizedBox(height: 10),

                // 人数
                _FieldGroup(
                  label: '乗車人数',
                  icon: Icons.group_outlined,
                  child: Row(
                    children: [
                      _CounterButton(
                        icon: Icons.remove,
                        onTap: () {
                          if (_partySize > 1) setState(() => _partySize--);
                        },
                      ),
                      Expanded(
                        child: Text(
                          '$_partySize 人',
                          textAlign: TextAlign.center,
                          style: const TextStyle(
                            fontSize: 18,
                            fontWeight: FontWeight.w800,
                            color: Color(0xFF1E293B),
                          ),
                        ),
                      ),
                      _CounterButton(
                        icon: Icons.add,
                        onTap: () => setState(() => _partySize++),
                      ),
                    ],
                  ),
                ),
                const SizedBox(height: 14),

                ElevatedButton.icon(
                  onPressed: () {},
                  icon: const Icon(Icons.taxi_alert_outlined, size: 18),
                  label: const Text('予約案を作成'),
                ),
              ],
            ),
          ),
          const SizedBox(height: 12),

          // 電話連携
          _SectionCard(
            title: '電話連携',
            icon: Icons.phone_in_talk_outlined,
            child: Row(
              children: [
                Container(
                  width: 40,
                  height: 40,
                  decoration: BoxDecoration(
                    color: const Color(0x14EA580C),
                    borderRadius: BorderRadius.circular(10),
                  ),
                  child: const Icon(Icons.phone_in_talk_outlined, color: _orange, size: 20),
                ),
                const SizedBox(width: 12),
                const Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        '電話連携アカウント',
                        style: TextStyle(
                          fontSize: 13,
                          fontWeight: FontWeight.w700,
                          color: Color(0xFF1E293B),
                        ),
                      ),
                      SizedBox(height: 2),
                      Text(
                        '発信者番号: +81 80-****-5678',
                        style: TextStyle(fontSize: 12, color: _inkMuted),
                      ),
                    ],
                  ),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

// ===== 運転手ページ =====

class DriverPage extends StatelessWidget {
  const DriverPage({super.key});

  @override
  Widget build(BuildContext context) {
    return SingleChildScrollView(
      padding: const EdgeInsets.all(16),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          // ステータスバー
          _DriverStatusBar(),
          const SizedBox(height: 14),

          // 現在のトリップ
          _SectionCard(
            title: '現在のトリップ',
            icon: Icons.route_outlined,
            accentColor: _orange,
            child: Column(
              children: [
                _TripTask(
                  index: 1,
                  type: 'pickup',
                  requestId: 'req_001',
                  stopLabel: '四万十市役所前',
                  eta: '約5分',
                ),
                const SizedBox(height: 8),
                _TripTask(
                  index: 2,
                  type: 'dropoff',
                  requestId: 'req_001',
                  stopLabel: '西土佐大宮バス停',
                  eta: '約18分',
                ),
                const SizedBox(height: 14),
                Row(
                  children: [
                    Expanded(
                      child: OutlinedButton.icon(
                        onPressed: () {},
                        icon: const Icon(Icons.check_circle_outline, size: 16),
                        label: const Text('乗車完了'),
                        style: OutlinedButton.styleFrom(
                          foregroundColor: _green,
                          side: const BorderSide(color: _green),
                          shape: RoundedRectangleBorder(
                            borderRadius: BorderRadius.circular(10),
                          ),
                          minimumSize: const Size(0, 40),
                          textStyle: const TextStyle(
                            fontSize: 13,
                            fontWeight: FontWeight.w700,
                          ),
                        ),
                      ),
                    ),
                    const SizedBox(width: 10),
                    Expanded(
                      child: ElevatedButton.icon(
                        onPressed: () {},
                        icon: const Icon(Icons.flag_outlined, size: 16),
                        label: const Text('降車完了'),
                        style: ElevatedButton.styleFrom(
                          backgroundColor: _orange,
                          foregroundColor: Colors.white,
                          shape: RoundedRectangleBorder(
                            borderRadius: BorderRadius.circular(10),
                          ),
                          minimumSize: const Size(0, 40),
                          textStyle: const TextStyle(
                            fontSize: 13,
                            fontWeight: FontWeight.w700,
                          ),
                        ),
                      ),
                    ),
                  ],
                ),
              ],
            ),
          ),
          const SizedBox(height: 12),

          // 次の予約
          _SectionCard(
            title: '待機中の予約',
            icon: Icons.schedule_outlined,
            child: const _EmptyState(message: '待機中の予約はありません'),
          ),
        ],
      ),
    );
  }
}

// ===== 共通ウィジェット =====

class _StatusChip extends StatelessWidget {
  final String label;
  final Color color;

  const _StatusChip({required this.label, required this.color});

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
      decoration: BoxDecoration(
        color: color.withOpacity(0.1),
        borderRadius: BorderRadius.circular(999),
        border: Border.all(color: color.withOpacity(0.25)),
      ),
      child: Text(
        label,
        style: TextStyle(
          fontSize: 10,
          fontWeight: FontWeight.w700,
          color: color,
          letterSpacing: 0.4,
        ),
      ),
    );
  }
}

class _KpiRow extends StatelessWidget {
  const _KpiRow();

  @override
  Widget build(BuildContext context) {
    return Container(
      decoration: BoxDecoration(
        color: Colors.white,
        borderRadius: BorderRadius.circular(14),
        border: Border.all(color: const Color(0x1A334155)),
      ),
      padding: const EdgeInsets.symmetric(vertical: 10),
      child: Row(
        children: [
          _KpiCell(label: '成功率', value: '-', flex: 1),
          _KpiDivider(),
          _KpiCell(label: '待機', value: '-', flex: 1),
          _KpiDivider(),
          _KpiCell(label: '車両', value: '0', flex: 1),
          _KpiDivider(),
          _KpiCell(label: '電話', value: '0', flex: 1),
        ],
      ),
    );
  }
}

class _KpiCell extends StatelessWidget {
  final String label;
  final String value;
  final int flex;

  const _KpiCell({required this.label, required this.value, this.flex = 1});

  @override
  Widget build(BuildContext context) {
    return Expanded(
      flex: flex,
      child: Column(
        children: [
          Text(
            value,
            style: const TextStyle(
              fontSize: 18,
              fontWeight: FontWeight.w900,
              color: _green,
              height: 1.2,
            ),
          ),
          Text(
            label,
            style: const TextStyle(
              fontSize: 10,
              fontWeight: FontWeight.w600,
              color: _inkMuted,
            ),
          ),
        ],
      ),
    );
  }
}

class _KpiDivider extends StatelessWidget {
  const _KpiDivider();

  @override
  Widget build(BuildContext context) {
    return Container(
      width: 1,
      height: 32,
      color: const Color(0x1A334155),
    );
  }
}

class _SectionCard extends StatelessWidget {
  final String title;
  final IconData icon;
  final Widget child;
  final Color? accentColor;

  const _SectionCard({
    required this.title,
    required this.icon,
    required this.child,
    this.accentColor,
  });

  @override
  Widget build(BuildContext context) {
    final color = accentColor ?? _green;
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(14),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Icon(icon, size: 15, color: color),
                const SizedBox(width: 6),
                Text(
                  title,
                  style: TextStyle(
                    fontSize: 13,
                    fontWeight: FontWeight.w800,
                    color: color,
                    letterSpacing: 0.3,
                  ),
                ),
              ],
            ),
            const SizedBox(height: 12),
            child,
          ],
        ),
      ),
    );
  }
}

class _FieldGroup extends StatelessWidget {
  final String label;
  final IconData icon;
  final Color? labelColor;
  final Widget child;

  const _FieldGroup({
    required this.label,
    required this.icon,
    required this.child,
    this.labelColor,
  });

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(
          children: [
            Icon(icon, size: 13, color: labelColor ?? _inkMuted),
            const SizedBox(width: 4),
            Text(
              label,
              style: TextStyle(
                fontSize: 11,
                fontWeight: FontWeight.w700,
                color: labelColor ?? _inkMuted,
                letterSpacing: 0.5,
              ),
            ),
          ],
        ),
        const SizedBox(height: 5),
        child,
      ],
    );
  }
}

class _ModeSelector extends StatelessWidget {
  final String value;
  final ValueChanged<String> onChanged;

  const _ModeSelector({required this.value, required this.onChanged});

  @override
  Widget build(BuildContext context) {
    return Row(
      children: [
        _ModeChip(
          label: '停留所',
          active: value == 'FIXED_STOP',
          onTap: () => onChanged('FIXED_STOP'),
        ),
        const SizedBox(width: 6),
        _ModeChip(
          label: '自由地点',
          active: value == 'FREE_POINT',
          onTap: () => onChanged('FREE_POINT'),
        ),
      ],
    );
  }
}

class _ModeChip extends StatelessWidget {
  final String label;
  final bool active;
  final VoidCallback onTap;

  const _ModeChip({required this.label, required this.active, required this.onTap});

  @override
  Widget build(BuildContext context) {
    return GestureDetector(
      onTap: onTap,
      child: AnimatedContainer(
        duration: const Duration(milliseconds: 150),
        padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 5),
        decoration: BoxDecoration(
          color: active ? _green : Colors.transparent,
          borderRadius: BorderRadius.circular(999),
          border: Border.all(
            color: active ? _green : const Color(0x33334155),
          ),
        ),
        child: Text(
          label,
          style: TextStyle(
            fontSize: 11,
            fontWeight: FontWeight.w700,
            color: active ? Colors.white : _inkMuted,
          ),
        ),
      ),
    );
  }
}

class _CounterButton extends StatelessWidget {
  final IconData icon;
  final VoidCallback onTap;

  const _CounterButton({required this.icon, required this.onTap});

  @override
  Widget build(BuildContext context) {
    return GestureDetector(
      onTap: onTap,
      child: Container(
        width: 36,
        height: 36,
        decoration: BoxDecoration(
          color: const Color(0x0F0F766E),
          borderRadius: BorderRadius.circular(10),
          border: Border.all(color: const Color(0x220F766E)),
        ),
        child: Icon(icon, size: 18, color: _green),
      ),
    );
  }
}

class _DriverStatusBar extends StatelessWidget {
  const _DriverStatusBar();

  @override
  Widget build(BuildContext context) {
    return Container(
      decoration: BoxDecoration(
        color: Colors.white,
        borderRadius: BorderRadius.circular(14),
        border: Border.all(color: const Color(0x1A334155)),
      ),
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
      child: Row(
        children: [
          Container(
            width: 10,
            height: 10,
            decoration: BoxDecoration(
              color: _green,
              shape: BoxShape.circle,
              boxShadow: [
                BoxShadow(
                  color: _green.withOpacity(0.4),
                  blurRadius: 6,
                  spreadRadius: 1,
                ),
              ],
            ),
          ),
          const SizedBox(width: 8),
          const Text(
            '運行中',
            style: TextStyle(
              fontSize: 13,
              fontWeight: FontWeight.w700,
              color: _green,
            ),
          ),
          const Spacer(),
          const Icon(Icons.local_taxi, size: 16, color: _inkMuted),
          const SizedBox(width: 4),
          const Text(
            'Vehicle #001',
            style: TextStyle(fontSize: 12, color: _inkMuted, fontWeight: FontWeight.w600),
          ),
        ],
      ),
    );
  }
}

class _TripTask extends StatelessWidget {
  final int index;
  final String type; // 'pickup' | 'dropoff'
  final String requestId;
  final String stopLabel;
  final String eta;

  const _TripTask({
    required this.index,
    required this.type,
    required this.requestId,
    required this.stopLabel,
    required this.eta,
  });

  @override
  Widget build(BuildContext context) {
    final isPickup = type == 'pickup';
    final color = isPickup ? _green : _orange;
    final icon = isPickup ? Icons.place_outlined : Icons.flag_outlined;
    final typeLabel = isPickup ? '乗車' : '降車';

    return Container(
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: color.withOpacity(0.06),
        borderRadius: BorderRadius.circular(10),
        border: Border.all(color: color.withOpacity(0.18)),
      ),
      child: Row(
        children: [
          Container(
            width: 28,
            height: 28,
            decoration: BoxDecoration(
              color: color.withOpacity(0.15),
              borderRadius: BorderRadius.circular(8),
            ),
            alignment: Alignment.center,
            child: Text(
              '$index',
              style: TextStyle(
                fontSize: 12,
                fontWeight: FontWeight.w900,
                color: color,
              ),
            ),
          ),
          const SizedBox(width: 10),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(
                  children: [
                    Icon(icon, size: 12, color: color),
                    const SizedBox(width: 3),
                    Text(
                      '$typeLabel: $requestId',
                      style: TextStyle(
                        fontSize: 11,
                        fontWeight: FontWeight.w700,
                        color: color,
                      ),
                    ),
                  ],
                ),
                const SizedBox(height: 2),
                Text(
                  stopLabel,
                  style: const TextStyle(
                    fontSize: 13,
                    fontWeight: FontWeight.w700,
                    color: Color(0xFF1E293B),
                  ),
                ),
              ],
            ),
          ),
          Text(
            eta,
            style: TextStyle(
              fontSize: 11,
              fontWeight: FontWeight.w700,
              color: color,
            ),
          ),
        ],
      ),
    );
  }
}

class _EmptyState extends StatelessWidget {
  final String message;

  const _EmptyState({required this.message});

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(vertical: 20),
      alignment: Alignment.center,
      child: Column(
        children: [
          Icon(
            Icons.calendar_today_outlined,
            size: 28,
            color: Colors.black.withOpacity(0.2),
          ),
          const SizedBox(height: 6),
          Text(
            message,
            style: TextStyle(
              fontSize: 12,
              color: Colors.black.withOpacity(0.35),
              fontWeight: FontWeight.w600,
            ),
          ),
        ],
      ),
    );
  }
}
