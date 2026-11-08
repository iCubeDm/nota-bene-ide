import 'dart:typed_data';

import 'package:flutter/widgets.dart';
import 'package:nb_app/chat/mermaid.dart';

/// A 1×1 PNG for any diagram, or an error for one whose source contains `((`.
class FakeMermaid implements MermaidRenderer {
  final calls = <String>[];
  final darks = <bool>[];

  static final png = Uint8List.fromList([
    0x89,
    0x50,
    0x4e,
    0x47,
    0x0d,
    0x0a,
    0x1a,
    0x0a,
    0x00,
    0x00,
    0x00,
    0x0d,
    0x49,
    0x48,
    0x44,
    0x52, //
    0x00,
    0x00,
    0x00,
    0x01,
    0x00,
    0x00,
    0x00,
    0x01,
    0x08,
    0x06,
    0x00,
    0x00,
    0x00,
    0x1f,
    0x15,
    0xc4,
    0x89,
    0x00,
    0x00,
    0x00,
    0x0d,
    0x49,
    0x44,
    0x41,
    0x54,
    0x78,
    0x9c,
    0x63,
    0x00,
    0x01,
    0x00,
    0x00,
    0x05,
    0x00,
    0x01,
    0x0d,
    0x0a,
    0x2d,
    0xb4,
    0x00,
    0x00,
    0x00,
    0x00,
    0x49,
    0x45,
    0x4e,
    0x44,
    0xae,
    0x42, 0x60, 0x82,
  ]);

  @override
  Future<MermaidImage> render(
    String source, {
    required bool dark,
    required double scale,
  }) async {
    calls.add(source);
    darks.add(dark);
    if (source.contains('((')) throw MermaidError('Parse error on line 2');
    return MermaidImage(png, 100, 50);
  }

  @override
  Widget? get engine => null;
}
