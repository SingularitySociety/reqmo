import 'package:flutter_test/flutter_test.dart';

import 'package:reqmo_mobile/main.dart';

void main() {
  testWidgets('Reqmo mobile app shows passenger and driver tabs', (WidgetTester tester) async {
    await tester.pumpWidget(const ReqmoMobileApp());

    expect(find.text('Reqmo Mobile'), findsOneWidget);
    expect(find.text('Request Ride'), findsOneWidget);

    await tester.tap(find.text('Driver'));
    await tester.pumpAndSettle();

    expect(find.text('Driver Console'), findsOneWidget);
    expect(find.text('Complete Trip'), findsOneWidget);
  });
}
